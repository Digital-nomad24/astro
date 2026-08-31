import { Logger, UsePipes, ValidationPipe, type OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
} from '@nestjs/websockets';
import {
  PRESENCE_MAX_SUBSCRIBED_CATEGORIES,
  PRESENCE_MAX_SUBSCRIBED_IDS,
  PRESENCE_NAMESPACE,
  err,
  ok,
  type Ack,
  type MentorPresenceSnapshot,
  type PresenceAckError,
  type PresenceState,
} from '@astro/contracts';
import { isDomainError } from '@astro/errors';
import type { Server, Socket } from 'socket.io';

import { IdentityResolutionService } from '../../../identity/application/services/identity-resolution.service';
import type { AuthenticatedUser } from '../../../identity/contracts/authenticated-user';
import { PresenceService } from '../../application/services/presence.service';
import {
  MentorGoOnlineDto,
  MentorSetAcceptingDto,
  PresenceSubscribeDto,
} from './dto/presence.socket.dto';

/**
 * What this gateway stores on a socket.
 *
 * Socket.IO types `data` as `any`, and an intersection does not fix that -- `any & T` is still
 * `any`. Narrowing has to be an explicit cast, done once in `dataOf` so no handler reads an
 * untyped identity.
 */
interface PresenceSocketData {
  user?: AuthenticatedUser;
}

/**
 * Live mentor availability.
 *
 * **Fan-out here is the exact opposite of the reference repo's convoy gateway.** Convoy used
 * `server.local.to(...)` because every instance independently recomputed identical state from
 * a shared store, so a cluster-wide emit would have delivered N duplicates. Presence is
 * genuinely event-driven -- one instance learns a mentor went online -- so emits MUST cross
 * instances, or a user browsing on instance B never sees the mentor who connected to instance
 * A. That correctness depends on the Socket.IO Redis adapter being active, which is why the
 * e2e suite boots two apps rather than one.
 */
@WebSocketGateway({ namespace: PRESENCE_NAMESPACE, cors: { origin: true, credentials: true } })
// The global ValidationPipe does not reach WebSocket payloads, so it is declared again here.
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  }),
)
export class PresenceGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit {
  private readonly logger = new Logger(PresenceGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly identity: IdentityResolutionService,
    private readonly presence: PresenceService,
  ) {}

  onModuleInit(): void {
    // Wiring the broadcast here keeps PresenceService free of any socket dependency, so the
    // same transitions can be driven from HTTP, the sweeper, or the sessions module in M4.
    this.presence.registerBroadcaster((snapshot) => this.broadcast(snapshot));
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
      // The same verification path HTTP uses, so the two cannot drift.
      const user = await this.identity.authenticate(token);
      dataOf(client).user = user;
      // Two-phase handshake: the socket exists before `client.data.user` does, and a client
      // that subscribes in that window races its own authentication.
      client.emit('presence:ready');
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket): void {
    // Deliberately does NOT mark a mentor offline.
    //
    // A refresh, a tunnel switch, or a backgrounded phone all produce a disconnect, and going
    // offline on each would make availability flap. The Redis TTL is the grace period: miss
    // enough heartbeats and the sweeper publishes OFFLINE. It is also the only approach that
    // works across instances, since this process cannot know whether the mentor still has a
    // socket open elsewhere.
    void client;
  }

  @SubscribeMessage('presence:subscribe')
  async onSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: PresenceSubscribeDto,
  ): Promise<Ack<{ snapshot: MentorPresenceSnapshot[] }, PresenceAckError>> {
    const user = this.userOf(client);
    if (!user) return err('unauthorized');

    // Each id becomes a room join, and every presence change fans out across them, so an
    // unbounded list lets one client make the whole fleet do arbitrary work. Returned as an
    // ack rather than thrown: a paging client should be able to react, not hang on a callback
    // that never fires.
    const categoryCount = body.categorySlugs?.length ?? 0;
    const mentorCount = body.mentorProfileIds?.length ?? 0;
    if (
      mentorCount > PRESENCE_MAX_SUBSCRIBED_IDS ||
      categoryCount > PRESENCE_MAX_SUBSCRIBED_CATEGORIES
    ) {
      return err('too_many_ids');
    }

    const rooms = [
      ...(body.categorySlugs ?? []).map(categoryRoom),
      ...(body.mentorProfileIds ?? []).map(mentorRoom),
    ];
    if (rooms.length > 0) await client.join(rooms);

    // The current state is returned in the ack rather than pushed, so a client has a complete
    // picture the moment it subscribes and needs no separate REST call to prime the UI.
    const snapshot = await this.presence.snapshotFor(body.mentorProfileIds ?? []);
    return ok({ snapshot });
  }

  @SubscribeMessage('presence:unsubscribe')
  async onUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: PresenceSubscribeDto,
  ): Promise<Ack<Record<never, never>, PresenceAckError>> {
    if (!this.userOf(client)) return err('unauthorized');

    for (const room of [
      ...(body.categorySlugs ?? []).map(categoryRoom),
      ...(body.mentorProfileIds ?? []).map(mentorRoom),
    ]) {
      await client.leave(room);
    }
    return ok();
  }

  @SubscribeMessage('mentor:go-online')
  async onGoOnline(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: MentorGoOnlineDto,
  ): Promise<Ack<{ state: PresenceState; ttlSeconds: number }, PresenceAckError>> {
    const user = this.userOf(client);
    if (!user) return err('unauthorized');
    if (user.role !== 'MENTOR' && user.role !== 'ADMIN') return err('not_a_mentor');

    try {
      const snapshot = await this.presence.goOnline(user.id, body.acceptingNewCalls ?? true);
      return ok({ state: snapshot.state, ttlSeconds: this.presence.heartbeatTtlSeconds });
    } catch (error) {
      return this.toAck(error);
    }
  }

  @SubscribeMessage('mentor:go-offline')
  async onGoOffline(
    @ConnectedSocket() client: Socket,
  ): Promise<Ack<{ state: 'OFFLINE' }, PresenceAckError>> {
    const user = this.userOf(client);
    if (!user) return err('unauthorized');
    if (user.role !== 'MENTOR' && user.role !== 'ADMIN') return err('not_a_mentor');

    try {
      await this.presence.goOffline(user.id);
      return ok({ state: 'OFFLINE' as const });
    } catch (error) {
      return this.toAck(error);
    }
  }

  @SubscribeMessage('mentor:set-accepting')
  async onSetAccepting(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: MentorSetAcceptingDto,
  ): Promise<Ack<{ acceptingNewCalls: boolean }, PresenceAckError>> {
    const user = this.userOf(client);
    if (!user) return err('unauthorized');
    if (user.role !== 'MENTOR' && user.role !== 'ADMIN') return err('not_a_mentor');

    try {
      const snapshot = await this.presence.setAccepting(user.id, body.accepting);
      return ok({ acceptingNewCalls: snapshot.acceptingNewCalls });
    } catch (error) {
      return this.toAck(error);
    }
  }

  @SubscribeMessage('presence:heartbeat')
  async onHeartbeat(
    @ConnectedSocket() client: Socket,
  ): Promise<Ack<{ ttlSeconds: number }, PresenceAckError>> {
    const user = this.userOf(client);
    if (!user) return err('unauthorized');

    try {
      const alive = await this.presence.heartbeat(user.id);
      // The record lapsed while the socket stayed open. The client must re-announce rather
      // than believe it is still visible to subscribers.
      if (!alive) return err('not_online');
      return ok({ ttlSeconds: this.presence.heartbeatTtlSeconds });
    } catch (error) {
      return this.toAck(error);
    }
  }

  /** Cluster-wide, never `.local` -- see the note on the class. */
  private broadcast(snapshot: MentorPresenceSnapshot): void {
    this.server
      .to([categoryRoom(snapshot.categorySlug), mentorRoom(snapshot.mentorProfileId)])
      .emit('presence:changed', snapshot);
  }

  private userOf(client: Socket): AuthenticatedUser | undefined {
    return dataOf(client).user;
  }

  /** Domain errors become ack codes; anything else is logged and reported as internal. */
  private toAck(error: unknown): Ack<never, PresenceAckError> {
    if (isDomainError(error)) {
      switch (error.code) {
        case 'MENTOR_PROFILE_NOT_FOUND':
          return err('not_a_mentor');
        case 'MENTOR_NOT_APPROVED':
          return err('not_approved');
        case 'NOT_ONLINE':
          return err('not_online');
        default:
          return err('forbidden');
      }
    }
    this.logger.error(`Unexpected presence error: ${String(error)}`);
    return err('internal');
  }
}

/** The single place the untyped `socket.data` bag is narrowed. */
const dataOf = (client: Socket): PresenceSocketData => client.data as PresenceSocketData;

const categoryRoom = (slug: string): string => `presence:cat:${slug}`;
const mentorRoom = (mentorProfileId: string): string => `presence:mentor:${mentorProfileId}`;
