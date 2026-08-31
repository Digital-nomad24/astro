/** A waiting user's place in line, as their client renders it. */
export interface QueuePositionView {
  readonly sessionId: string;
  readonly mentorProfileId: string;
  /** 1-based. Position 1 is next to be promoted, not "currently ringing". */
  readonly position: number;
  /** How many people are waiting in total, so a client can show "3 of 7". */
  readonly queueDepth: number;
  /**
   * Best-effort wait estimate. Derived from the mentor's own average session length once they
   * have history, and from `ETA_DEFAULT_SESSION_S` before that — so it is a hint, never a
   * promise, and the UI should present it as one.
   */
  readonly etaSeconds: number;
  /** ISO. When this entry expires if it has not been promoted by then. */
  readonly expiresAt: string;
}

/** Why a user stopped waiting. The durable record lives on `QueueEntry`. */
export const QUEUE_LEAVE_REASONS = [
  'PROMOTED',
  'CANCELLED_BY_USER',
  'TTL_EXPIRED',
  'DISCONNECTED',
  'MENTOR_OFFLINE',
] as const;
export type QueueLeaveReason = (typeof QUEUE_LEAVE_REASONS)[number];
