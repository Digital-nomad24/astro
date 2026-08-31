import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatHistoryPage, ChatMessageView, ChatRetentionNotice } from '@astro/contracts';
import { ConflictError, TooManyRequestsError, ValidationError } from '@astro/errors';

import type { EnvVars } from '../../../../config/env.schema';
import { decodeCursor, encodeCursor } from '../../../common/pagination/cursor';
import type { AuthenticatedUser } from '../../../identity/contracts/authenticated-user';
import type { ISessionRecord } from '../../../sessions/domain/repos/session.repos';
import { SessionLifecycleService } from '../../../sessions/application/services/session-lifecycle.service';
import type { IChatMessageRecord, IChatMessageRepo } from '../../domain/repos/chat.repos';
import { ChatRateLimitService } from '../../infra/redis/chat-rate-limit.service';
import { CHAT_MESSAGE_REPO } from '../../tokens';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SendMessageResult {
  readonly message: ChatMessageView;
  readonly duplicate: boolean;
  readonly session: ISessionRecord;
}

export interface JoinChatResult {
  readonly session: ISessionRecord;
  readonly history: ChatHistoryPage;
  readonly retention: ChatRetentionNotice;
}

/**
 * Text consultation messaging.
 *
 * Cross-domain access goes through `SessionLifecycleService` — this module never touches
 * `ISessionRepo`. What it does own is the transcript, plus the handful of chat columns
 * denormalised onto the `Session` row; see the note on `IChatMessageRepo`.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly pageSize: number;
  private readonly maxLength: number;
  private readonly retentionDays: number;

  constructor(
    @Inject(CHAT_MESSAGE_REPO) private readonly messages: IChatMessageRepo,
    private readonly sessions: SessionLifecycleService,
    private readonly rateLimit: ChatRateLimitService,
    config: ConfigService<EnvVars, true>,
  ) {
    this.pageSize = config.get('CHAT_HISTORY_PAGE_SIZE', { infer: true });
    this.maxLength = config.get('CHAT_MESSAGE_MAX_LENGTH', { infer: true });
    this.retentionDays = config.get('CHAT_RETENTION_DAYS', { infer: true });
  }

  get messageMaxLength(): number {
    return this.maxLength;
  }

  /**
   * Authorises a participant and returns the recent history inline.
   *
   * Readable for any session the caller took part in, including ended ones — history is the
   * point. Only *sending* requires ACTIVE.
   */
  async join(user: AuthenticatedUser, sessionId: string): Promise<JoinChatResult> {
    const session = await this.requireTextSession(user, sessionId);
    return {
      session,
      history: await this.historyPage(session, undefined, this.pageSize),
      retention: this.retentionNoticeFor(session),
    };
  }

  async history(
    user: AuthenticatedUser,
    sessionId: string,
    before: string | undefined,
    limit: number | undefined,
  ): Promise<ChatHistoryPage> {
    const session = await this.requireTextSession(user, sessionId);
    return this.historyPage(session, before, Math.min(Math.max(limit ?? this.pageSize, 1), 200));
  }

  /**
   * Stores a message and returns it. **The caller broadcasts only after this resolves.**
   *
   * That ordering is the one rule here worth stating twice: a message the recipient saw but
   * the history does not contain is the bug users never forgive, and it is the default
   * outcome of emitting first because the emit is the fast path.
   */
  async send(
    user: AuthenticatedUser,
    params: { sessionId: string; body: string; clientMsgId: string },
  ): Promise<SendMessageResult> {
    const body = params.body.trim();
    if (body.length === 0) {
      throw new ValidationError('EMPTY_MESSAGE', 'A message cannot be empty.');
    }
    if (body.length > this.maxLength) {
      throw new ValidationError(
        'MESSAGE_TOO_LONG',
        `A message may be at most ${this.maxLength} characters.`,
        { maxLength: this.maxLength },
      );
    }

    const session = await this.requireTextSession(user, params.sessionId);
    if (session.status !== 'ACTIVE') {
      throw new ConflictError(
        'SESSION_NOT_ACTIVE',
        'That conversation has ended, so no further messages can be sent.',
      );
    }

    if (!(await this.rateLimit.allow(user.id, params.sessionId))) {
      this.logger.warn({
        event: 'chat.rate_limited',
        sessionId: params.sessionId,
        userId: user.id,
      });
      throw new TooManyRequestsError(
        'CHAT_RATE_LIMITED',
        'You are sending messages too quickly. Please slow down.',
      );
    }

    // The repo re-checks ACTIVE inside its transaction. The check above is the friendly error;
    // that one is the guarantee, and it is what stops a session that ends mid-send from
    // accepting one last message.
    const result = await this.messages.append({
      sessionId: params.sessionId,
      senderUserId: user.id,
      body,
      clientMsgId: params.clientMsgId,
      at: new Date(),
    });

    if (result.anchored) {
      // Metering for a text session starts at the first message, not at accept. Announced so
      // the UI's "billing started" state means the same thing as the meter's.
      this.logger.log({ event: 'chat.anchored', sessionId: params.sessionId });
      await this.sessions.announceTextAnchor(params.sessionId);
    }

    return {
      message: toMessageView(result.message),
      duplicate: result.duplicate,
      session,
    };
  }

  /**
   * Authorises a participant on a text session. Throws 404 for a non-participant rather than
   * 403 — the same rule as `GET /sessions/:id`, so a session id cannot be probed for existence.
   */
  async requireTextSession(user: AuthenticatedUser, sessionId: string): Promise<ISessionRecord> {
    const session = await this.sessions.requireParticipant(sessionId, user);
    if (session.mode !== 'TEXT') {
      throw new ConflictError(
        'NOT_A_TEXT_SESSION',
        'That session is a voice call and has no message history.',
      );
    }
    return session;
  }

  /**
   * When this transcript is due for deletion, so the UI can say so rather than letting the
   * messages silently vanish between two visits.
   *
   * Null while the session is live: retention is measured from the end, and a call in progress
   * has no end yet.
   */
  retentionNoticeFor(session: ISessionRecord): ChatRetentionNotice {
    return {
      retentionDays: this.retentionDays,
      deleteAfter: session.endedAt
        ? new Date(session.endedAt.getTime() + this.retentionDays * DAY_MS).toISOString()
        : null,
    };
  }

  private async historyPage(
    session: ISessionRecord,
    before: string | undefined,
    limit: number,
  ): Promise<ChatHistoryPage> {
    // A purged transcript short-circuits: querying would return the same empty array, but the
    // caller could not tell "deleted" from "nobody spoke" — and those need different UI.
    if (session.messagesPurgedAt) {
      return {
        messages: [],
        nextCursor: null,
        purgedAt: session.messagesPurgedAt.toISOString(),
        messageCount: session.messageCount,
      };
    }

    const cursor = before ? decodeCursor(before) : null;
    const rows = await this.messages.history(session.id, limit, cursor);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const oldest = page[page.length - 1];

    return {
      messages: page.map(toMessageView),
      nextCursor:
        hasMore && oldest
          ? encodeCursor({ v: oldest.createdAt.toISOString(), id: oldest.id })
          : null,
      purgedAt: null,
      messageCount: session.messageCount,
    };
  }
}

export const toMessageView = (record: IChatMessageRecord): ChatMessageView => ({
  id: record.id,
  sessionId: record.sessionId,
  senderUserId: record.senderUserId,
  body: record.body,
  createdAt: record.createdAt.toISOString(),
  clientMsgId: record.clientMsgId,
});
