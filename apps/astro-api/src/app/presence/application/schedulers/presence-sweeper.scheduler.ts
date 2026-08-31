import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import type { EnvVars } from '../../../../config/env.schema';
import { LeaderLockService } from '../../../infra/redis/leader-lock.service';
import type { IMentorProfileRepo } from '../../../mentors/domain/repos/mentor.repos';
import { MENTOR_PROFILE_REPO } from '../../../mentors/tokens';
import type { IPresenceRepo } from '../../domain/repos/presence.repo.interface';
import { PRESENCE_REPO } from '../../tokens';
import { PresenceService } from '../services/presence.service';

/**
 * Publishes the OFFLINE transition for mentors who stopped heartbeating.
 *
 * The Redis TTL already makes a stale mentor invisible to any *lookup*, so this is not what
 * makes presence correct — it is what makes the transition observable. An expired key is
 * simply gone; without this sweep, subscribers who were watching a mentor would never receive
 * `presence:changed`, and their card would sit on "online" until they reloaded.
 *
 * This is the first `@Cron` in the codebase, so it sets the precedent: **every scheduled job
 * takes the leader lock.** We deploy up to 20 instances, and the reference repo's crons relied
 * on an undocumented `--max-instances=1` for their single-firing guarantee. That guarantee
 * does not exist here.
 */
@Injectable()
export class PresenceSweeperScheduler {
  private readonly logger = new Logger(PresenceSweeperScheduler.name);
  private readonly ttlSeconds: number;

  constructor(
    @Inject(PRESENCE_REPO) private readonly presence: IPresenceRepo,
    @Inject(MENTOR_PROFILE_REPO) private readonly mentors: IMentorProfileRepo,
    private readonly presenceService: PresenceService,
    private readonly leaderLock: LeaderLockService,
    config: ConfigService<EnvVars, true>,
  ) {
    this.ttlSeconds = config.get('PRESENCE_TTL_S', { infer: true });
  }

  /**
   * Nothing may escape this method.
   *
   * A `@Cron` handler that rejects becomes an unhandled promise rejection, which in Node
   * terminates the process by default — so a transient Redis blip, or a tick that lands during
   * shutdown, would take down an instance serving live calls. Background work fails quietly
   * and retries on the next tick; it never takes the process with it.
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async sweepStale(): Promise<void> {
    try {
      await this.leaderLock.withLock('presence:sweep', () => this.run());
    } catch (err) {
      this.logger.warn(
        `Presence sweep tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async run(): Promise<void> {
    // Same cutoff as the TTL, so the sweep observes exactly the mentors Redis has already
    // stopped serving. A shorter window would evict mentors that lookups still consider live.
    const cutoff = Date.now() - this.ttlSeconds * 1000;
    const stale = await this.presence.findStale(cutoff);
    if (stale.length === 0) return;

    let swept = 0;
    for (const mentorProfileId of stale) {
      try {
        // The category and rate are needed for the OFFLINE snapshot. A mentor deleted since
        // going online has no row — clear the Redis remnant and move on.
        const mentor = await this.mentors.findById(mentorProfileId);
        if (!mentor) {
          await this.presence.clear(mentorProfileId);
          continue;
        }

        await this.presenceService.markOffline(
          mentorProfileId,
          mentor.categorySlug,
          mentor.ratePaisePerMinute,
        );
        swept += 1;
      } catch (err) {
        // Per-item isolation: one bad mentor must not abort the batch and leave the rest
        // stuck online. Not clearing on failure means it retries on the next tick.
        this.logger.error(
          `Failed to sweep presence for ${mentorProfileId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (swept > 0) {
      this.logger.log({ event: 'presence.swept', count: swept, staleCandidates: stale.length });
    }
  }
}
