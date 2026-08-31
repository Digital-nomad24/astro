import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { QueueLeaveReason, QueuePositionView, SessionMode } from '@astro/contracts';

import type { EnvVars } from '../../../../config/env.schema';
import type { IMentorProfileRepo } from '../../../mentors/domain/repos/mentor.repos';
import { MENTOR_PROFILE_REPO } from '../../../mentors/tokens';
import type { ISessionQueue } from '../../../sessions/domain/ports/session-queue.port';
import { SessionLifecycleService } from '../../../sessions/application/services/session-lifecycle.service';
import type { IQueueEntryRepo, IQueueRedisRepo } from '../../domain/repos/queue.repos';
import { QUEUE_ENTRY_REPO, QUEUE_REDIS_REPO } from '../../tokens';

/** How many promotions one `dispatchNext` will attempt before giving up for this round. */
const MAX_PROMOTION_ATTEMPTS = 5;

/**
 * The per-mentor waiting line.
 *
 * Authority is split rather than duplicated: **Redis answers "what is my position" and "who is
 * next"; Postgres answers "who waited and how did they leave".** Neither is a cache of the
 * other. Redis holds ordering because that is a sorted set and a `ZPOPMIN`; Postgres holds the
 * record because Redis can be flushed and a ledger cannot.
 *
 * Registers itself with `SessionLifecycleService` at init rather than being injected into it —
 * this service already depends on the lifecycle to promote sessions, and a dependency the
 * other way would be a cycle.
 */
@Injectable()
export class QueueService implements ISessionQueue, OnModuleInit {
  private readonly logger = new Logger(QueueService.name);
  private readonly entryTtlSeconds: number;
  private readonly defaultSessionSeconds: number;
  private readonly dispatchLockTtlSeconds: number;

  constructor(
    @Inject(QUEUE_ENTRY_REPO) private readonly entries: IQueueEntryRepo,
    @Inject(QUEUE_REDIS_REPO) private readonly redis: IQueueRedisRepo,
    @Inject(MENTOR_PROFILE_REPO) private readonly mentors: IMentorProfileRepo,
    private readonly lifecycle: SessionLifecycleService,
    config: ConfigService<EnvVars, true>,
  ) {
    this.entryTtlSeconds = config.get('QUEUE_ENTRY_TTL_S', { infer: true });
    this.defaultSessionSeconds = config.get('ETA_DEFAULT_SESSION_S', { infer: true });
    // Long enough to cover a promotion including LiveKit room creation, short enough that a
    // crashed dispatcher does not stall the queue for minutes.
    this.dispatchLockTtlSeconds = 30;
  }

  onModuleInit(): void {
    this.lifecycle.registerQueue(this);
  }

  // ------------------------------------------------------------------ writes

  depthFor(mentorProfileId: string): Promise<number> {
    return this.redis.depth(mentorProfileId);
  }

  /**
   * Postgres first, then Redis.
   *
   * The durable record has to exist before the live one, because the reconciler rebuilds Redis
   * *from* Postgres. In the other order, a crash between the two writes would leave a member
   * in the sorted set that the reconciler would then delete as an orphan — silently dropping
   * someone who was told they were in line.
   */
  async enqueue(params: {
    sessionId: string;
    mentorProfileId: string;
    userId: string;
    mode: SessionMode;
  }): Promise<QueuePositionView> {
    const enqueuedAt = new Date();

    await this.entries.create({
      sessionId: params.sessionId,
      mentorProfileId: params.mentorProfileId,
      userId: params.userId,
      mode: params.mode,
      enqueuedAt,
    });
    const position = await this.redis.enqueue(
      params.mentorProfileId,
      params.sessionId,
      enqueuedAt.getTime(),
    );

    this.logger.log({
      event: 'queue.enqueued',
      sessionId: params.sessionId,
      mentorProfileId: params.mentorProfileId,
      position,
    });

    return this.viewFor(params.mentorProfileId, params.sessionId, position, enqueuedAt);
  }

  async positionOf(sessionId: string): Promise<QueuePositionView | null> {
    const entry = await this.entries.findBySessionId(sessionId);
    if (!entry || entry.status !== 'WAITING') return null;

    const position = await this.redis.positionOf(entry.mentorProfileId, sessionId);
    if (position === null) return null;

    return this.viewFor(entry.mentorProfileId, sessionId, position, entry.enqueuedAt);
  }

  async release(sessionId: string, reason: 'CANCELLED_BY_USER' | 'MENTOR_OFFLINE'): Promise<void> {
    const entry = await this.entries.findBySessionId(sessionId);
    if (!entry || entry.status !== 'WAITING') return;

    await this.leave(sessionId, reason);
  }

  /**
   * Removes an entry from both stores and tells everyone behind it that they moved up.
   *
   * Postgres first again, and for a sharper reason than in `enqueue`: `leave` is a
   * compare-and-swap on `status: 'WAITING'`, so it is what decides who won when a promotion
   * races the TTL sweep. Doing the Redis removal first would let both callers proceed.
   */
  private async leave(
    sessionId: string,
    reason: Exclude<QueueLeaveReason, 'PROMOTED'>,
  ): Promise<boolean> {
    const status = reason === 'CANCELLED_BY_USER' ? 'CANCELLED' : 'EXPIRED';
    const left = await this.entries.leave({
      sessionId,
      status,
      reason,
      at: new Date(),
    });
    if (!left) return false;

    await this.redis.remove(left.mentorProfileId, sessionId);

    this.logger.log({
      event: 'queue.left',
      sessionId,
      mentorProfileId: left.mentorProfileId,
      reason,
    });
    this.lifecycle.emitQueue({ kind: 'queue-left', userId: left.userId, sessionId, reason });
    await this.pushPositions(left.mentorProfileId);
    return true;
  }

  // --------------------------------------------------------------- dispatch

  /**
   * Promotes the head of a mentor's queue, if there is one and they are free.
   *
   * The loop exists because a promotion can fail for a reason that does not mean "stop": the
   * user at the head may have vanished between being queued and being reached. `MENTOR_BUSY`
   * is the one outcome that ends the round — someone else got there first, and their session
   * is now the mentor's one in-flight slot.
   */
  async dispatchNext(mentorProfileId: string): Promise<void> {
    for (let attempt = 0; attempt < MAX_PROMOTION_ATTEMPTS; attempt += 1) {
      const lockToken = randomUUID();
      const claimed = await this.redis.claimNext(
        mentorProfileId,
        lockToken,
        this.dispatchLockTtlSeconds,
      );
      // Either the queue is empty or another instance holds the dispatch lock. Both mean
      // "not our turn", and neither is an error.
      if (!claimed) return;

      try {
        const handled = await this.promote(mentorProfileId, claimed);
        if (handled === 'STOP') return;
      } finally {
        // Compare-and-delete, so a dispatch that overran its TTL cannot free a lock another
        // instance has since taken.
        await this.redis.releaseDispatchLock(mentorProfileId, lockToken);
      }
    }

    this.logger.warn({
      event: 'queue.dispatch_exhausted',
      mentorProfileId,
      attempts: MAX_PROMOTION_ATTEMPTS,
    });
  }

  private async promote(
    mentorProfileId: string,
    claimed: { sessionId: string; scoreMs: number },
  ): Promise<'STOP' | 'CONTINUE'> {
    const { sessionId, scoreMs } = claimed;

    // The entry has already been popped out of Redis by `claimNext`. Marking it PROMOTED here
    // is the compare-and-swap that settles a race with the TTL sweeper; if it lost, the entry
    // is already CANCELLED or EXPIRED and there is nobody to ring.
    const entry = await this.entries.leave({
      sessionId,
      status: 'PROMOTED',
      reason: 'PROMOTED',
      at: new Date(),
    });
    if (!entry) return 'CONTINUE';

    const { outcome } = await this.lifecycle.promoteToRinging(sessionId);

    if (outcome === 'MENTOR_BUSY') {
      // Another instance promoted a different user microseconds earlier and
      // `session_one_inflight_per_mentor` rejected this one. Put them back **at their original
      // score** — losing a race they never knew about must not cost them their place — and
      // stop, because the mentor is no longer free.
      //
      // `reinstate`, not `create`: the entry still exists, and re-creating it would collide on
      // `QueueEntry.sessionId` and lose the `enqueuedAt` that the score depends on.
      await this.entries.reinstate(sessionId);
      await this.redis.reinstate(mentorProfileId, sessionId, scoreMs);

      this.logger.log({ event: 'queue.promotion_lost', sessionId, mentorProfileId });
      await this.pushPositions(mentorProfileId);
      return 'STOP';
    }

    if (outcome === 'GONE') {
      // The user cancelled, timed out, or their room could not be created. Their place is
      // already gone from both stores; move on to whoever is behind them.
      this.logger.log({ event: 'queue.promotion_skipped', sessionId, mentorProfileId });
      await this.pushPositions(mentorProfileId);
      return 'CONTINUE';
    }

    this.logger.log({ event: 'queue.promoted', sessionId, mentorProfileId });
    await this.pushPositions(mentorProfileId);
    return 'STOP';
  }

  // ------------------------------------------------------------ abandonment

  /** The hard TTL, the disconnect grace, and the mentor-offline dissolve all land here. */
  async expire(sessionId: string, reason: Exclude<QueueLeaveReason, 'PROMOTED'>): Promise<void> {
    if (!(await this.leave(sessionId, reason))) return;

    // The session is CANCELLED with a reason that matches why they stopped waiting, so a
    // history row explains itself without a join back to the queue entry.
    await this.lifecycle.terminate(
      sessionId,
      reason === 'MENTOR_OFFLINE' ? 'MENTOR_OFFLINE' : 'QUEUE_EXPIRED',
    );
  }

  onUserDisconnected(userId: string): Promise<void> {
    // Not a removal. Backgrounding a mobile app produces a disconnect, and dissolving
    // someone's place for it would make the queue unusable on a phone. The sweeper acts only
    // after the grace period.
    return this.entries.setDisconnectedAt(userId, new Date());
  }

  onUserConnected(userId: string): Promise<void> {
    return this.entries.setDisconnectedAt(userId, null);
  }

  // ---------------------------------------------------------------- helpers

  /**
   * Re-pushes every remaining position for one mentor.
   *
   * One departure moves everyone behind it, and depth is capped at 20 — so re-sending the
   * whole line is cheaper than working out who actually needs telling, and cannot drift.
   */
  async pushPositions(mentorProfileId: string): Promise<void> {
    try {
      const members = await this.redis.members(mentorProfileId);
      const waiting = await this.entries.findWaitingForMentor(mentorProfileId);
      const userBySession = new Map(waiting.map((entry) => [entry.sessionId, entry.userId]));

      for (const [index, member] of members.entries()) {
        const userId = userBySession.get(member.sessionId);
        if (!userId) continue;

        this.lifecycle.emitQueue({
          kind: 'queue-position',
          userId,
          position: await this.viewFor(
            mentorProfileId,
            member.sessionId,
            index + 1,
            new Date(member.scoreMs),
          ),
        });
      }
    } catch (error) {
      // Cosmetic. A stale position corrects itself on the next departure or on resync.
      this.logger.warn({
        event: 'queue.position_push_failed',
        mentorProfileId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The wait estimate.
   *
   * `position × averageSessionLength`, where the average is this mentor's own history once
   * they have any and `ETA_DEFAULT_SESSION_S` before that. Deliberately does not try to
   * subtract the elapsed part of the call in progress: that number is knowable but noisy, and
   * an estimate that visibly jumps around reads as broken even when it is more accurate.
   */
  private async viewFor(
    mentorProfileId: string,
    sessionId: string,
    position: number,
    enqueuedAt: Date,
  ): Promise<QueuePositionView> {
    const [depth, average] = await Promise.all([
      this.redis.depth(mentorProfileId),
      this.mentors.averageSessionSeconds(mentorProfileId),
    ]);

    return {
      sessionId,
      mentorProfileId,
      position,
      queueDepth: depth,
      etaSeconds: position * (average && average > 0 ? average : this.defaultSessionSeconds),
      expiresAt: new Date(enqueuedAt.getTime() + this.entryTtlSeconds * 1000).toISOString(),
    };
  }
}
