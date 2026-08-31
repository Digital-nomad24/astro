import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { LeaderLockService } from '../../../infra/redis/leader-lock.service';
import type { IQueueEntryRepo, IQueueRedisRepo } from '../../domain/repos/queue.repos';
import { QUEUE_ENTRY_REPO, QUEUE_REDIS_REPO } from '../../tokens';
import { QueueService } from '../services/queue.service';

/**
 * Rebuilds Redis from Postgres, and dispatches anyone left stranded.
 *
 * This is what makes the split authority safe to rely on. Redis holds the ordering because
 * that is a sorted set; Postgres holds the record because Redis is a cache that can be flushed,
 * evicted, or restarted empty. Without this job, a `FLUSHDB` would silently delete every
 * waiting user's place while their clients kept showing a position that no longer existed.
 *
 * Two directions of drift, both repaired here:
 *
 * - **Missing members** — a WAITING entry with no place in the sorted set. Re-added **at its
 *   original score**, so a rebuilt queue puts everyone back where they were rather than in the
 *   order the rebuild happened to reach them.
 * - **Orphan members** — a place in the sorted set whose entry is no longer WAITING. Left
 *   behind by a promotion that crashed between popping and settling; dropped, because the
 *   dispatcher would otherwise promote a session that has already ended.
 *
 * It also nudges any mentor who is free but has people waiting. A dispatch is triggered by a
 * session ending, and if *that* is the moment an instance died, nothing else would ever start
 * the queue moving again.
 */
@Injectable()
export class QueueReconcilerScheduler {
  private readonly logger = new Logger(QueueReconcilerScheduler.name);

  constructor(
    @Inject(QUEUE_ENTRY_REPO) private readonly entries: IQueueEntryRepo,
    @Inject(QUEUE_REDIS_REPO) private readonly redis: IQueueRedisRepo,
    private readonly queue: QueueService,
    private readonly leaderLock: LeaderLockService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async reconcile(): Promise<void> {
    try {
      await this.leaderLock.withLock('queue:reconcile', () => this.run(), 120);
    } catch (error) {
      this.logger.warn(`Queue reconcile tick failed: ${describe(error)}`);
    }
  }

  private async run(): Promise<void> {
    const mentors = await this.entries.findMentorsWithWaiting();

    let repaired = 0;
    for (const mentorProfileId of mentors) {
      try {
        if (await this.reconcileMentor(mentorProfileId)) repaired += 1;
        // Whether or not anything was repaired: a free mentor with a queue needs a nudge, and
        // `dispatchNext` is a no-op when they are busy or the lock is held.
        await this.queue.dispatchNext(mentorProfileId);
      } catch (error) {
        this.logger.error(
          `Failed to reconcile queue for mentor ${mentorProfileId}: ${describe(error)}`,
        );
      }
    }

    if (repaired > 0) {
      this.logger.warn({ event: 'queue.reconciled', mentors: repaired, scanned: mentors.length });
    }
  }

  /** Returns true when the mentor's sorted set actually differed from the durable record. */
  private async reconcileMentor(mentorProfileId: string): Promise<boolean> {
    const waiting = await this.entries.findWaitingForMentor(mentorProfileId);
    const members = await this.redis.members(mentorProfileId);

    const expected = waiting.map((entry) => ({
      sessionId: entry.sessionId,
      scoreMs: entry.enqueuedAt.getTime(),
    }));

    const same =
      expected.length === members.length &&
      expected.every(
        (entry, index) =>
          members[index]?.sessionId === entry.sessionId &&
          members[index]?.scoreMs === entry.scoreMs,
      );
    if (same) return false;

    // One atomic replace rather than a diff. `DEL` + `ZADD` as separate commands would leave a
    // window in which the queue looks empty, and a concurrent dispatch would conclude there is
    // nobody to promote — the reconciler causing the starvation it exists to repair.
    await this.redis.rebuild(mentorProfileId, expected);

    this.logger.warn({
      event: 'queue.rebuilt',
      mentorProfileId,
      durable: expected.length,
      live: members.length,
    });
    await this.queue.pushPositions(mentorProfileId);
    return true;
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
