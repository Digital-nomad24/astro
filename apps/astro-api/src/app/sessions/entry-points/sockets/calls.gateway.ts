import { Logger, UsePipes, ValidationPipe, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
} from '@nestjs/websockets';
import {
  CALLS_NAMESPACE,
  callsUserRoom,
  err,
  ok,
  type Ack,
  type CallJoinCredentials,
  type CallsAckError,
  type QueuePositionView,
  type SessionView,
} from '@astro/contracts';
import type { Server, Socket } from 'socket.io';

import type { EnvVars } from '../../../../config/env.schema';
import { IdentityResolutionService } from '../../../identity/application/services/identity-resolution.service';
import type { AuthenticatedUser } from '../../../identity/contracts/authenticated-user';
import { toSessionView } from '../../application/mappers/session.mapper';
import {
  SessionLifecycleService,
  type SessionBroadcast,
} from '../../application/services/session-lifecycle.service';

interface CallsSocketData {
  user?: AuthenticatedUser;
}

/**
 * Live session signalling.
 *
 * **This namespace pushes; it does not write.** Every transition is an HTTP route on
 * `SessionsController`, so there is one code path per transition rather than two that can
 * disagree about who may do what. What a socket adds is the unsolicited half — a mentor's
 * dashboard has to learn about a call it never asked for — plus `calls:resync`, which is the
 * reconnect path.
 *
 * Every socket auto-joins its own user room on connect. A user only ever cares about their own
 * sessions, so an explicit subscribe would add a race (ring before subscribe) and buy nothing.
 *
 * Emits are cluster-wide, never `.local`: the two participants in a consultation are routinely
 * connected to different instances, which is the entire reason the Redis adapter is mandatory.
 */
@WebSocketGateway({ namespace: CALLS_NAMESPACE, cors: { origin: true, credentials: true } })
// The global ValidationPipe does not reach WebSocket payloads.
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
export class CallsGateway implements OnGatewayConnection, OnModuleInit {
  private readonly logger = new Logger(CallsGateway.name);
  private readonly ringTimeoutSeconds: number;

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly identity: IdentityResolutionService,
    private readonly lifecycle: SessionLifecycleService,
    config: ConfigService<EnvVars, true>,
  ) {
    this.ringTimeoutSeconds = config.get('RING_TIMEOUT_S', { infer: true });
  }

  onModuleInit(): void {
    // Wired as a callback so the lifecycle service never imports a socket type — the same
    // transitions have to be drivable from HTTP, the webhook processor and the sweeper.
    this.lifecycle.addBroadcaster((event) => this.broadcast(event));
  }

  async handleConnection(client: Socket): Promise<void> {
    const auth = client.handshake.auth as { token?: unknown } | undefined;
    const raw = auth?.token ?? client.handshake.query?.token;
    const token = typeof raw === 'string' ? raw : undefined;

    if (!token) {
      client.disconnect();
      return;
    }

    try {
      const user = await this.identity.authenticate(token);
      dataOf(client).user = user;
      // Joined BEFORE `calls:ready` is emitted. The other order would leave a window in which
      // a client believes it is listening while an incoming call is fanned out to a room it
      // has not entered — and a missed ring is the one event this product cannot drop.
      await client.join(callsUserRoom(user.id));
      // Cancels any queue disconnect grace still running. A refresh mid-wait must not cost
      // someone their place.
      await this.lifecycle.reportUserPresence(user.id, true);
      client.emit('calls:ready');
    } catch {
      client.disconnect();
    }
  }

  /**
   * Starts the queue's disconnect grace — it does NOT remove anyone.
   *
   * A refresh, a tunnel switch or a backgrounded phone all land here, and treating any of them
   * as abandonment would make the queue unusable on mobile. The sweeper decides after
   * `QUEUE_DISCONNECT_GRACE_S`, and a reconnect inside that window cancels it.
   */
  handleDisconnect(client: Socket): void {
    const user = dataOf(client).user;
    if (!user) return;
    void this.lifecycle.reportUserPresence(user.id, false);
  }

  /**
   * Reconnect. Returns whatever is in flight for this caller, plus fresh join credentials.
   *
   * `session: null` is a success, not an error — "I am not in a call" is a legitimate answer,
   * and making it an error would force every client to treat the common case as a failure.
   */
  @SubscribeMessage('calls:resync')
  async onResync(@ConnectedSocket() client: Socket): Promise<
    Ack<
      {
        session: SessionView | null;
        credentials: CallJoinCredentials | null;
        queue: QueuePositionView | null;
      },
      CallsAckError
    >
  > {
    const user = dataOf(client).user;
    if (!user) return err('unauthorized');

    try {
      const session = await this.lifecycle.findInflightFor(user);
      if (!session) return ok({ session: null, credentials: null, queue: null });

      return ok({
        session: toSessionView(session),
        credentials: await this.lifecycle.credentialsFor(session, user.id),
        // A client reconnecting mid-wait needs its position back in the same round trip, not
        // on whenever the next person happens to leave the queue.
        queue:
          session.status === 'QUEUED' ? await this.lifecycle.queuePositionFor(session.id) : null,
      });
    } catch (error) {
      this.logger.error(`calls:resync failed for ${user.id}: ${describe(error)}`);
      return err('internal');
    }
  }

  /**
   * Fan-out for one lifecycle event.
   *
   * Both participants receive every event, **including the one who caused it**. That is
   * deliberate: a client that acted optimistically and one that only watched then converge on
   * the same server-sent state, so neither has to reconcile a local guess.
   */
  private broadcast(event: SessionBroadcast): void {
    // Queue events address one user, not the pair — the mentor has no interest in how long
    // someone else's line is.
    if (event.kind === 'queue-position') {
      this.server.to(callsUserRoom(event.userId)).emit('queue:position', event.position);
      return;
    }
    if (event.kind === 'queue-left') {
      this.server
        .to(callsUserRoom(event.userId))
        .emit('queue:left', { sessionId: event.sessionId, reason: event.reason });
      return;
    }

    const { session } = event;
    const rooms = [callsUserRoom(session.userId), callsUserRoom(session.mentorUserId)];
    const view = toSessionView(session);

    switch (event.kind) {
      case 'incoming': {
        // The ring goes only to the mentor — the caller already has the session in the HTTP
        // response that created it, and does not need to be told their own phone is ringing.
        this.server.to(callsUserRoom(session.mentorUserId)).emit('calls:incoming', {
          session: view,
          ringExpiresAtMs:
            event.ringExpiresAtMs ??
            (session.ringingAt?.getTime() ?? Date.now()) + this.ringTimeoutSeconds * 1000,
        });
        return;
      }

      case 'connected': {
        this.server.to(rooms).emit('calls:connected', {
          sessionId: session.id,
          billingAnchorAt: session.billingAnchorAt?.toISOString() ?? new Date().toISOString(),
        });
        // Also as a state change, so a client that missed the specific event still converges.
        this.server.to(rooms).emit('calls:state', { session: view });
        return;
      }

      case 'ended': {
        this.server.to(rooms).emit('calls:ended', {
          sessionId: session.id,
          endReason: session.endReason ?? 'ADMIN_TERMINATED',
          endedAt: session.endedAt?.toISOString() ?? new Date().toISOString(),
          billedSeconds: view.billedSeconds,
        });
        this.server.to(rooms).emit('calls:state', { session: view });
        return;
      }

      case 'state':
      default: {
        this.server.to(rooms).emit('calls:state', { session: view });
      }
    }
  }
}

/** The single place the untyped `socket.data` bag is narrowed — `any & T` is still `any`. */
const dataOf = (client: Socket): CallsSocketData => client.data as CallsSocketData;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
