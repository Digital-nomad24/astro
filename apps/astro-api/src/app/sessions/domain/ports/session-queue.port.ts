import type { QueuePositionView, SessionMode } from '@astro/contracts';

/**
 * What the sessions module needs from a queue, without knowing one exists.
 *
 * `SessionLifecycleService` cannot import the queue module: the queue promotes sessions, so it
 * already depends on the lifecycle, and a direct dependency the other way is a cycle. Instead
 * the queue **registers itself** at init, the same inversion the socket gateways use for
 * broadcasts.
 *
 * The upshot is that M6 is genuinely additive. With nothing registered, a busy mentor is a
 * `409 MENTOR_BUSY` exactly as it was in M4 and M5 — the behaviour those milestones were
 * tested against — and the sessions module has no idea which of the two worlds it is in.
 */
export interface ISessionQueue {
  /** How many are waiting. A non-zero depth means even a free mentor must be queued for. */
  depthFor(mentorProfileId: string): Promise<number>;

  /** Places an already-created QUEUED session in line. */
  enqueue(params: {
    readonly sessionId: string;
    readonly mentorProfileId: string;
    readonly userId: string;
    readonly mode: SessionMode;
  }): Promise<QueuePositionView>;

  /** Current place in line, or null once the session has left the queue. */
  positionOf(sessionId: string): Promise<QueuePositionView | null>;

  /**
   * Removes a session from the queue because it is ending by some other route — the user
   * cancelled, an admin terminated it. Safe to call for a session that was never queued.
   */
  release(sessionId: string, reason: 'CANCELLED_BY_USER' | 'MENTOR_OFFLINE'): Promise<void>;

  /**
   * A mentor just became free. Fire-and-forget: a failure here must never fail the transition
   * that freed them, because the reconciler and the periodic dispatch will catch it.
   */
  dispatchNext(mentorProfileId: string): Promise<void>;

  /**
   * The user's socket dropped. **Not a removal** — backgrounding a mobile app produces exactly
   * this, and dissolving someone's place for it would make the queue unusable on a phone. The
   * queue starts a grace timer; the sweeper decides.
   */
  onUserDisconnected(userId: string): Promise<void>;
  /** The user is back before the grace expired. Clears the timer. */
  onUserConnected(userId: string): Promise<void>;
}
