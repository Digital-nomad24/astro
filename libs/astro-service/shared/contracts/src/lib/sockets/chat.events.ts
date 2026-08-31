import type { SessionEndReason } from '../enums';
import type { ChatHistoryPage, ChatMessageView, ChatRetentionNotice } from '../chat';
import type { Ack, CommonAckError } from './ack';

export const CHAT_NAMESPACE = '/chat' as const;

export type ChatAckError =
  | CommonAckError
  | 'not_a_participant'
  | 'session_not_active'
  | 'not_joined'
  | 'message_too_long'
  | 'transcript_purged';

/**
 * The text consultation stream.
 *
 * Ring, accept and end are NOT here — they are the same HTTP routes and the same `/calls`
 * push that a voice session uses, because a mentor accepts a text consultation exactly as
 * they accept a call. That is what lets a busy mentor have one queue in M6 rather than one
 * per mode. This namespace carries only what is specific to text: the messages.
 *
 * `chat:ended` is duplicated here rather than left to `/calls` for one reason: the chat pane
 * has to close, and a client that has the chat open but has not subscribed to `/calls` — a
 * transcript viewer, say — would otherwise never learn the conversation was over.
 */
export interface ChatServerToClient {
  /** After auth. A client that joins before this races its own authentication. */
  'chat:ready': () => void;

  /**
   * A new message, fanned out cluster-wide to both participants — including the sender, whose
   * optimistic bubble is reconciled by `clientMsgId`. Emitted only AFTER the row is committed:
   * a message the recipient saw but the history does not contain is the one bug users never
   * forgive.
   */
  'chat:message': (payload: ChatMessageView) => void;

  /** Not persisted, not billed, not guaranteed. Best-effort presence sugar. */
  'chat:typing': (payload: { sessionId: string; userId: string }) => void;

  'chat:ended': (payload: {
    sessionId: string;
    endReason: SessionEndReason;
    endedAt: string;
  }) => void;

  /**
   * The transcript has been deleted under a client that still has it open. Rare — it needs a
   * pane left open across the retention window — but the alternative is a UI showing messages
   * the server no longer has.
   */
  'chat:purged': (payload: { sessionId: string; purgedAt: string; messageCount: number }) => void;
}

export interface ChatClientToServer {
  /**
   * Join a session's room and get the most recent page inline.
   *
   * History comes back in the ack rather than over a separate REST call because a refresh
   * mid-conversation is the common case, not the exceptional one — one round trip, and the
   * pane is repopulated before the first new message can arrive.
   */
  'chat:join': (
    payload: { sessionId: string },
    ack: (
      result: Ack<{ history: ChatHistoryPage; retention: ChatRetentionNotice }, ChatAckError>,
    ) => void,
  ) => void;

  'chat:leave': (
    payload: { sessionId: string },
    ack: (result: Ack<Record<never, never>, ChatAckError>) => void,
  ) => void;

  /** Older messages. `before` is the opaque cursor from the previous page. */
  'chat:history': (
    payload: { sessionId: string; before?: string; limit?: number },
    ack: (result: Ack<{ history: ChatHistoryPage }, ChatAckError>) => void,
  ) => void;

  /**
   * `clientMsgId` is required, not optional. It is what makes a retry after a reconnect
   * idempotent, and a client that omits it would double-post on every flaky connection —
   * so the server refuses rather than accepting a message it cannot de-duplicate.
   */
  'chat:send': (
    payload: { sessionId: string; body: string; clientMsgId: string },
    ack: (
      result: Ack<{ message: ChatMessageView; duplicate: boolean }, ChatAckError>,
    ) => void,
  ) => void;

  'chat:typing': (
    payload: { sessionId: string },
    ack: (result: Ack<Record<never, never>, ChatAckError>) => void,
  ) => void;
}

export const chatSessionRoom = (sessionId: string): string => `chat:session:${sessionId}`;

/** Bounds a single message. Shared so a client can count before sending, not after failing. */
export const CHAT_MESSAGE_MAX_LENGTH = 4000 as const;
