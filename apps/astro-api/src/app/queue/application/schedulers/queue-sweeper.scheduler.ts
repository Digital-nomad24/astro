import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import type { EnvVars } from '../../../../config/env.schema';
import { LeaderLockService } from '../../../infra/redis/leader-lock.service';
import { PresenceService } from '../../../presence/application/services/presence.service';
import type { IQueueEntryRepo, IQueueRedisRepo } from '../../domain/repos/queue.repos';
import { QUEUE_ENTRY_REPO, QUEUE_REDIS_REPO } from '../../tokens';
import { QueueService } from '../services/queue.service';

const BATCH_SIZE = 200;

/**
 * The three ways a user stops waiting without being promoted.
 *
 * They are separate paths because they mean different things and want different timings:
 *
 * - **Hard TTL** (`QUEUE_ENTRY_TTL_S`, 30 min). Nobody should sit in a queue for half an hour
 *   believing a call is coming.
 * - **Disconnect grace** (`QUEUE_DISCONNECT_GRACE_S`, 90 s). Measured from when the socket
 *   dropped, not from the drop itself — backgrounding a mobile app produces a disconnect, and
 *   removing someone's place for it would make the queue unusable on a phone.
 * - **Mentor offline hold** (`QUEUE_MENTOR_OFFLINE_GRACE_S`, 120 s). **The queue is held, not
 *   dissolved.** A mentor switching from wifi to mobile data drops presence for a few seconds;
 *   a twenty-person queue evaporating because of that is a product failure, not a cleanup.
 */
@Injectable()
export class QueueSweeperScheduler {
  private readonly logger = new Logger(QueueSweeperScheduler.name);
  private readonly entryTtlSeconds: number;
  private readonly disconnectGraceSeconds: number;
  private readonly mentorOfflineGraceSeconds: number;

  constructor(
    @Inject(QUEUE_ENTRY_REPO) private readonly entries: IQueueEntryRepo,
    @Inject(QUEUE_REDIS_REPO) private readonly redis: IQueueRedisRepo,
    private readonly queue: QueueService,
    private readonly presence: PresenceService,
    private readonly leaderLock: LeaderLockService,
    config: ConfigService<EnvVars, true>,
  ) {
    this.entryTtlSeconds = config.get('QUEUE_ENTRY_TTL_S', { infer: true });
    this.disconnectGraceSeconds = config.get('QUEUE_DISCONNECT_GRACE_S', { infer: true });
    this.mentorOfflineGraceSeconds = config.get('QUEUE_MENTOR_OFFLINE_GRACE_S', { infer: true });
  }

  /** Nothing may escape: an unhandled rejection from a `@Cron` takes the process down. */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async sweep(): Promise<void> {
    try {
      await this.leaderLock.withLock('queue:sweep', () => this.run(), 60);
    } catch (error) {
      this.logger.warn(`Queue sweep tick failed: ${describe(error)}`);
    }
  }

  private async run(): Promise<void> {
    const now = Date.now();

    await this.expireAll(
      await this.entries.findWaitingEnqueuedBefore(
        new Date(now - this.entryTtlSeconds * 1000),
        BATCH_SIZE,
      ),
      'TTL_EXPIRED',
    );

    await this.expireAll(
      await this.entries.findWaitingDisconnectedBefore(
        new Date(now - this.disconnectGraceSeconds * 1000),
        BATCH_SIZE,
      ),
      'DISCONNECTED',
    );

    await this.dissolveQueuesOfOfflineMentors(now);
  }

  /**
   * A mentor who has been unreachable past the hold has their queue dissolved.
   *
   * The hold is tracked in Redis rather than derived from presence, because presence has no
   * memory: an expired key is simply gone, so "offline right now" is knowable but "offline
   * since when" is not. That timestamp is the whole of this rule.
   */
  private async dissolveQueuesOfOfflineMentors(now: number): Promise<void> {
    const mentors = await this.entries.findMentorsWithWaiting();
    if (mentors.length === 0) return;

    const live = await this.presence.snapshotFor(mentors);
    const online = new Set(live.map((snapshot) => snapshot.mentorProfileId));

    for (const mentorProfileId of mentors) {
      try {
        if (online.has(mentorProfileId)) {
          // Back. Clear the clock so a later blip starts a fresh hold rather than inheriting
          // time already served.
          await this.redis.setMentorOfflineSince(mentorProfileId, null);
          continue;
        }

        const since = await this.redis.getMentorOfflineSince(mentorProfileId);
        if (!since) {
          // First tick that noticed. `SET NX` means a repeated OFFLINE cannot push the
          // deadline back.
          await this.redis.setMentorOfflineSince(mentorProfileId, new Date(now));
          continue;
        }

        if (now - since.getTime() < this.mentorOfflineGraceSeconds * 1000) continue;

        const waiting = await this.entries.findWaitingForMentor(mentorProfileId);
        for (const entry of waiting) {
          await this.queue.expire(entry.sessionId, 'MENTOR_OFFLINE');
        }
        await this.redis.setMentorOfflineSince(mentorProfileId, null);

        this.logger.warn({
          event: 'queue.dissolved',
          mentorProfileId,
          released: waiting.length,
          offlineForSeconds: Math.round((now - since.getTime()) / 1000),
        });
      } catch (error) {
        // Per-mentor isolation: one wedged queue must not stop the others being swept.
        this.logger.error(
          `Failed to evaluate offline hold for mentor ${mentorProfileId}: ${describe(error)}`,
        );
      }
    }
  }

  private async expireAll(
    candidates: readonly { sessionId: string }[],
    reason: 'TTL_EXPIRED' | 'DISCONNECTED',
  ): Promise<void> {
    let expired = 0;
    for (const candidate of candidates) {
      try {
        await this.queue.expire(candidate.sessionId, reason);
        expired += 1;
      } catch (error) {
        this.logger.error(
          `Failed to expire queue entry ${candidate.sessionId} (${reason}): ${describe(error)}`,
        );
      }
    }

    if (expired > 0) {
      this.logger.log({ event: 'queue.expired', reason, count: expired });
    }
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
