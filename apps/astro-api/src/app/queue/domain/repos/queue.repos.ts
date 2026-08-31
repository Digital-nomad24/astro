import type { QueueLeaveReason, SessionMode } from '@astro/contracts';

export interface IQueueEntryRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly mentorProfileId: string;
  readonly userId: string;
  readonly mode: SessionMode;
  readonly status: 'WAITING' | 'PROMOTED' | 'CANCELLED' | 'EXPIRED';
  readonly enqueuedAt: Date;
  readonly disconnectedAt: Date | null;
  readonly promotedAt: Date | null;
  readonly leftAt: Date | null;
  readonly leaveReason: string | null;
}

export interface ICreateQueueEntryParams {
  readonly sessionId: string;
  readonly mentorProfileId: string;
  readonly userId: string;
  readonly mode: SessionMode;
  readonly enqueuedAt: Date;
}

/**
 * The durable half. Answers who waited and how they left; never asked "who is next", which is
 * a `ZPOPMIN` and belongs in Redis.
 */
export interface IQueueEntryRepo {
  create(params: ICreateQueueEntryParams): Promise<IQueueEntryRecord>;
  findBySessionId(sessionId: string): Promise<IQueueEntryRecord | null>;

  /** Still WAITING for this mentor, oldest first — the reconciler's source of truth. */
  findWaitingForMentor(mentorProfileId: string): Promise<IQueueEntryRecord[]>;
  /** Every WAITING entry across all mentors, oldest first. Bounded by the caller. */
  findAllWaiting(limit: number): Promise<IQueueEntryRecord[]>;
  /** Distinct mentors with at least one WAITING entry. */
  findMentorsWithWaiting(): Promise<string[]>;

  /**
   * Compare-and-swap out of WAITING. Returns null when someone else already moved this entry —
   * the promotion racing the TTL sweep is routine, and exactly one of them must take effect.
   */
  leave(params: {
    readonly sessionId: string;
    readonly status: 'PROMOTED' | 'CANCELLED' | 'EXPIRED';
    readonly reason: QueueLeaveReason;
    readonly at: Date;
  }): Promise<IQueueEntryRecord | null>;

  /**
   * Puts a PROMOTED entry back to WAITING after the promotion lost the mentor.
   *
   * A re-`create` would be wrong twice over: `sessionId` is unique on this table, so it throws;
   * and even if it did not, a new row would lose the original `enqueuedAt` that the score and
   * the reconciler both depend on. The entry that already exists is the one to revive.
   */
  reinstate(sessionId: string): Promise<IQueueEntryRecord | null>;

  /** Marks the user's socket as gone, or back. Null clears the grace timer on reconnect. */
  setDisconnectedAt(userId: string, at: Date | null): Promise<void>;

  /** WAITING entries enqueued before the cutoff — the hard TTL sweep. */
  findWaitingEnqueuedBefore(cutoff: Date, limit: number): Promise<IQueueEntryRecord[]>;
  /** WAITING entries whose socket has been gone longer than the grace period. */
  findWaitingDisconnectedBefore(cutoff: Date, limit: number): Promise<IQueueEntryRecord[]>;
}

/**
 * The live half: ordering, position, and the pop.
 *
 * One sorted set per mentor, **scored by enqueue time in milliseconds**. That single choice
 * buys three things at once: stable FIFO ordering; an exact-place rollback when a promotion
 * fails, because the original score is known and re-insertable; and expiry as
 * `ZRANGEBYSCORE -inf (cutoff)` — a range query rather than a scan of every waiting user.
 */
export interface IQueueRedisRepo {
  /** Returns the 1-based position after insertion. Idempotent on the session id. */
  enqueue(mentorProfileId: string, sessionId: string, scoreMs: number): Promise<number>;

  /** Puts an entry back at its ORIGINAL score after a failed promotion. */
  reinstate(mentorProfileId: string, sessionId: string, scoreMs: number): Promise<void>;

  remove(mentorProfileId: string, sessionId: string): Promise<boolean>;

  /** 1-based, or null when the session is not in this queue. */
  positionOf(mentorProfileId: string, sessionId: string): Promise<number | null>;
  depth(mentorProfileId: string): Promise<number>;
  /** Every member in score order. Used to re-push positions after someone leaves. */
  members(mentorProfileId: string): Promise<{ sessionId: string; scoreMs: number }[]>;

  /**
   * Atomically takes the dispatch lock and pops the head, or returns null.
   *
   * Both in one Lua script because `ZPOPMIN` alone is not enough. `ZPOPMIN` guarantees two
   * instances cannot pop the *same member* — it says nothing about two instances each popping
   * a *different* member and both building a session against one free mentor. The lock is what
   * serialises the whole pop → promote → notify sequence.
   *
   * Even that is not the real guarantee: `session_one_inflight_per_mentor` is. The lock makes
   * the race rare; the unique index makes losing it harmless.
   */
  claimNext(
    mentorProfileId: string,
    lockToken: string,
    lockTtlSeconds: number,
  ): Promise<{ sessionId: string; scoreMs: number } | null>;

  /** Compare-and-delete, so a slow dispatch cannot release a lock someone else now holds. */
  releaseDispatchLock(mentorProfileId: string, lockToken: string): Promise<void>;

  /** Replaces a mentor's queue wholesale, at the given scores. The reconciler's write. */
  rebuild(
    mentorProfileId: string,
    entries: readonly { sessionId: string; scoreMs: number }[],
  ): Promise<void>;

  /** Records when a mentor went offline, so the hold can be measured. Null clears it. */
  setMentorOfflineSince(mentorProfileId: string, at: Date | null): Promise<void>;
  getMentorOfflineSince(mentorProfileId: string): Promise<Date | null>;
}
