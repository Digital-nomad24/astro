import type { SessionEndReason } from '../enums';
import type { QueueLeaveReason, QueuePositionView } from '../queue';
import type { CallJoinCredentials, SessionView } from '../session';
import type { Ack, CommonAckError } from './ack';

export const CALLS_NAMESPACE = '/calls' as const;

/**
 * The `/calls` namespace is a **push channel, not a write channel.**
 *
 * Every mutation — create, accept, decline, cancel, end, consent — is an HTTP route. Those get
 * the global `ValidationPipe`, `AllExceptionsFilter`, Swagger and ordinary status codes for
 * free, and there is exactly one code path per transition rather than two that can drift.
 * What a socket adds that HTTP cannot is the *unsolicited* half: a mentor's dashboard has to
 * learn about a ringing call it never asked for.
 *
 * So the only client→server event here is `calls:resync`, which exists for reconnects.
 */
export type CallsAckError = CommonAckError | 'not_a_participant' | 'session_not_active';

/** Server → client. */
export interface CallsServerToClient {
  /**
   * Emitted after authentication, once the socket has been joined to its own user room. A
   * client that acts before this can miss the very event it connected for.
   */
  'calls:ready': () => void;

  /**
   * A session is RINGING for this mentor. Carries the full view rather than an id so the
   * dashboard can render the caller without a follow-up fetch on the most latency-sensitive
   * screen in the product.
   */
  'calls:incoming': (payload: {
    session: SessionView;
    /** Epoch millis. The client counts down against this rather than trusting its own start. */
    ringExpiresAtMs: number;
  }) => void;

  /**
   * Any status change. Both parties receive it, including the one who caused it — so a client
   * never has to reconcile its optimistic local state against the server's.
   */
  'calls:state': (payload: { session: SessionView }) => void;

  /**
   * The far side is connected and media should be flowing. Sent when the billing anchor is
   * stamped, so "the call has started" means the same thing to the UI as it does to the meter.
   */
  'calls:connected': (payload: { sessionId: string; billingAnchorAt: string }) => void;

  'calls:ended': (payload: {
    sessionId: string;
    endReason: SessionEndReason;
    endedAt: string;
    billedSeconds: number | null;
  }) => void;

  /**
   * The waiting user's place in line, pushed whenever it changes.
   *
   * Sent to everyone still in a mentor's queue each time someone leaves it, because one
   * departure moves every person behind them. Depth is capped at 20, so re-sending the whole
   * queue is cheaper than working out who needs telling.
   */
  'queue:position': (payload: QueuePositionView) => void;

  /**
   * The user has left the queue without being promoted. `PROMOTED` never arrives here — that
   * is a `calls:state` transition to RINGING, because from the user's side it is the call
   * starting rather than the wait ending.
   */
  'queue:left': (payload: {
    sessionId: string;
    reason: Exclude<QueueLeaveReason, 'PROMOTED'>;
  }) => void;
}

/** Client → server. */
export interface CallsClientToServer {
  /**
   * The reconnect path, and the reason this namespace has an ack at all.
   *
   * A refresh mid-call drops the socket but not the session — LiveKit keeps the media up for
   * `departureTimeout`. This returns the caller's current in-flight session plus fresh join
   * credentials, so recovery is one round trip and the client never has to guess whether it
   * is still in a call.
   *
   * Returns `session: null` when there is nothing in flight. That is a success, not an error:
   * "I am not in a call" is the answer, and making it an error would force every client to
   * treat the normal case as a failure branch.
   */
  'calls:resync': (
    payload: Record<never, never>,
    ack: (
      result: Ack<
        {
          session: SessionView | null;
          credentials: CallJoinCredentials | null;
          /** Present only while the session is QUEUED. */
          queue: QueuePositionView | null;
        },
        CallsAckError
      >,
    ) => void,
  ) => void;
}

/** Per-user room. A user only ever cares about their own sessions, so joining is automatic. */
export const callsUserRoom = (userId: string): string => `calls:user:${userId}`;
