import { Logger, UsePipes, ValidationPipe, type OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
} from '@nestjs/websockets';
import {
  CHAT_NAMESPACE,
  chatSessionRoom,
  err,
  ok,
  type Ack,
  type ChatAckError,
  type ChatHistoryPage,
  type ChatMessageView,
  type ChatRetentionNotice,
} from '@astro/contracts';
import { isDomainError } from '@astro/errors';
import type { Server, Socket } from 'socket.io';

import { IdentityResolutionService } from '../../../identity/application/services/identity-resolution.service';
import type { AuthenticatedUser } from '../../../identity/contracts/authenticated-user';
import {
  SessionLifecycleService,
  type SessionBroadcast,
} from '../../../sessions/application/services/session-lifecycle.service';
import { ChatService } from '../../application/services/chat.service';
import { ChatHistoryDto, ChatJoinDto, ChatSendDto, ChatTypingDto } from './dto/chat.socket.dto';

interface ChatSocketData {
  user?: AuthenticatedUser;
  /**
   * Sessions this socket has been authorised for, cached after `chat:join`.
   *
   * Participation is immutable, so caching it is safe and saves a database read per message on
   * the hot path. What is deliberately NOT cached is whether the session is still ACTIVE —
   * that changes, and it is re-checked inside the send transaction. Cache for speed, constrain
   * for correctness.
   */
  joined?: Set<string>;
}

/**
 * The text consultation message stream.
 *
 * Ring, accept and end are not here: a mentor accepts a text consultation through the same
 * HTTP routes and the same `/calls` push as a voice call, which is what lets M6 give a busy
 * mentor one queue rather than one per mode. This namespace carries only the messages.
 *
 * Fan-out is cluster-wide (`server.to(...)`, never `.local`) — the two participants in a
 * consultation are routinely connected to different instances, which is the whole reason the
 * Redis adapter is mandatory.
 */
@WebSocketGateway({ namespace: CHAT_NAMESPACE, cors: { origin: true, credentials: true } })
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
export class ChatGateway implements OnGatewayConnection, OnModuleInit {
  private readonly logger = new Logger(ChatGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly identity: IdentityResolutionService,
    private readonly chat: ChatService,
    private readonly lifecycle: SessionLifecycleService,
  ) {}

  onModuleInit(): void {
    // One of several subscribers — `/calls` renders the call state, this closes the message
    // pane. A client with the transcript open but no `/calls` socket would otherwise never
    // learn the conversation had ended.
    this.lifecycle.addBroadcaster((event) => this.onSessionEvent(event));
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
      const data = dataOf(client);
      data.user = user;
      data.joined = new Set<string>();
      // Two-phase handshake: the socket exists before the identity is resolved, and a client
      // that joins in that window races its own authentication.
      client.emit('chat:ready');
    } catch {
      client.disconnect();
    }
  }

  /**
   * Join a conversation and get its most recent page in the same round trip.
   *
   * History in the ack rather than a separate REST call is the point: a refresh mid-conversation
   * is the common case, and the pane must be repopulated before the first new message arrives.
   */
  @SubscribeMessage('chat:join')
  async onJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ChatJoinDto,
  ): Promise<Ack<{ history: ChatHistoryPage; retention: ChatRetentionNotice }, ChatAckError>> {
    const user = dataOf(client).user;
    if (!user) return err('unauthorized');

    try {
      const result = await this.chat.join(user, body.sessionId);
      await client.join(chatSessionRoom(body.sessionId));
      dataOf(client).joined?.add(body.sessionId);

      return ok({ history: result.history, retention: result.retention });
    } catch (error) {
      return this.toAck(error, 'chat:join');
    }
  }

  @SubscribeMessage('chat:leave')
  async onLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ChatJoinDto,
  ): Promise<Ack<Record<never, never>, ChatAckError>> {
    if (!dataOf(client).user) return err('unauthorized');

    await client.leave(chatSessionRoom(body.sessionId));
    dataOf(client).joined?.delete(body.sessionId);
    return ok();
  }

  @SubscribeMessage('chat:history')
  async onHistory(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ChatHistoryDto,
  ): Promise<Ack<{ history: ChatHistoryPage }, ChatAckError>> {
    const user = dataOf(client).user;
    if (!user) return err('unauthorized');

    try {
      return ok({
        history: await this.chat.history(user, body.sessionId, body.before, body.limit),
      });
    } catch (error) {
      return this.toAck(error, 'chat:history');
    }
  }

  /**
   * Send a message.
   *
   * **Persist, then broadcast.** The emit is the fast path and doing it first would be the
   * natural mistake; the result is a message the recipient saw that the history does not
   * contain, which is the one bug users never forgive.
   *
   * A duplicate `clientMsgId` returns the stored message with `duplicate: true` and emits
   * nothing — the retrying client reconciles its optimistic bubble, and the other party is not
   * shown the message twice.
   */
  @SubscribeMessage('chat:send')
  async onSend(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ChatSendDto,
  ): Promise<Ack<{ message: ChatMessageView; duplicate: boolean }, ChatAckError>> {
    const user = dataOf(client).user;
    if (!user) return err('unauthorized');
    // Not merely an optimisation: joining is what authorised this socket for the session, and
    // sending without it would skip that check entirely.
    if (!dataOf(client).joined?.has(body.sessionId)) return err('not_joined');

    // Answered as an ack rather than thrown from the pipe. An over-long message is something a
    // user does, not an attack, and a thrown error never reaches the callback.
    if (body.body.length > this.chat.messageMaxLength) return err('message_too_long');

    try {
      const result = await this.chat.send(user, {
        sessionId: body.sessionId,
        body: body.body,
        clientMsgId: body.clientMsgId,
      });

      if (!result.duplicate) {
        this.server.to(chatSessionRoom(body.sessionId)).emit('chat:message', result.message);
      }

      return ok({ message: result.message, duplicate: result.duplicate });
    } catch (error) {
      return this.toAck(error, 'chat:send');
    }
  }

  /**
   * Typing indicators. Not persisted, not billed, not acknowledged to the sender's own socket.
   *
   * Deliberately does no database work at all — it is the highest-frequency event in the
   * product and the only one whose loss costs nothing.
   */
  @SubscribeMessage('chat:typing')
  onTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ChatTypingDto,
  ): Ack<Record<never, never>, ChatAckError> {
    const user = dataOf(client).user;
    if (!user) return err('unauthorized');
    if (!dataOf(client).joined?.has(body.sessionId)) return err('not_joined');

    // `client.broadcast` excludes the sender — nobody needs to be told they are typing.
    client.broadcast
      .to(chatSessionRoom(body.sessionId))
      .emit('chat:typing', { sessionId: body.sessionId, userId: user.id });
    return ok();
  }

  /** Closes the pane when the session ends by any route: hang-up, idle sweep, admin. */
  private onSessionEvent(event: SessionBroadcast): void {
    if (event.kind !== 'ended') return;
    if (event.session.mode !== 'TEXT') return;

    this.server.to(chatSessionRoom(event.session.id)).emit('chat:ended', {
      sessionId: event.session.id,
      endReason: event.session.endReason ?? 'ADMIN_TERMINATED',
      endedAt: event.session.endedAt?.toISOString() ?? new Date().toISOString(),
    });
  }

  /** Tells a client its transcript is gone, for the rare pane left open across the window. */
  announcePurge(sessionId: string, purgedAt: Date, messageCount: number): void {
    this.server.to(chatSessionRoom(sessionId)).emit('chat:purged', {
      sessionId,
      purgedAt: purgedAt.toISOString(),
      messageCount,
    });
  }

  private toAck(error: unknown, event: string): Ack<never, ChatAckError> {
    if (isDomainError(error)) {
      switch (error.code) {
        case 'SESSION_NOT_FOUND':
          return err('not_found');
        case 'NOT_A_TEXT_SESSION':
        case 'SESSION_NOT_ACTIVE':
          return err('session_not_active');
        case 'MESSAGE_TOO_LONG':
          return err('message_too_long');
        case 'EMPTY_MESSAGE':
          return err('invalid_payload');
        case 'CHAT_RATE_LIMITED':
          return err('rate_limited');
        case 'INVALID_CURSOR':
          return err('invalid_payload');
        default:
          return err('forbidden');
      }
    }
    this.logger.error(`Unexpected error in ${event}: ${String(error)}`);
    return err('internal');
  }
}

/** The single place the untyped `socket.data` bag is narrowed — `any & T` is still `any`. */
const dataOf = (client: Socket): ChatSocketData => client.data as ChatSocketData;
