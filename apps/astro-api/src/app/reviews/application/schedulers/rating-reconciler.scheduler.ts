import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { LeaderLockService } from '../../../infra/redis/leader-lock.service';
import type { IMentorProfileRepo } from '../../../mentors/domain/repos/mentor.repos';
import { MENTOR_PROFILE_REPO } from '../../../mentors/tokens';
import type { IReviewRepo } from '../../domain/repos/review.repos';
import { REVIEW_REPO } from '../../tokens';

/**
 * Re-derives every mentor's rating from the reviews themselves and corrects any drift.
 *
 * `MentorProfile.ratingSum/Count/Avg` is a cache of `Review`, kept current by a transaction
 * rather than by this job — so on a healthy system this reports **zero corrections**, every
 * night, and that is the point. It is a detector first and a repair second: a non-zero count
 * here means something wrote a review outside the transaction, and no amount of correcting
 * will stop that recurring.
 *
 * The alternative to caching is computing the average per row on every browse query, which is
 * a sort over the whole catalogue on the hottest read path in the product. So the cache stays,
 * and this is the cost of keeping it honest.
 */
@Injectable()
export class RatingReconcilerScheduler {
  private readonly logger = new Logger(RatingReconcilerScheduler.name);

  constructor(
    @Inject(REVIEW_REPO) private readonly reviews: IReviewRepo,
    @Inject(MENTOR_PROFILE_REPO) private readonly mentors: IMentorProfileRepo,
    private readonly leaderLock: LeaderLockService,
  ) {}

  /**
   * Nightly, off-peak. Nothing may escape: an unhandled rejection from a `@Cron` takes the
   * process down, and this one shares instances with live calls.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async reconcile(): Promise<void> {
    try {
      await this.leaderLock.withLock('reviews:reconcile', () => this.run(), 600);
    } catch (error) {
      this.logger.warn(
        `Rating reconcile tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Exposed so the e2e suite can drive it without waiting for 3am. */
  async run(): Promise<{ scanned: number; corrected: number }> {
    const truth = await this.reviews.deriveRatingTruth();
    const byMentor = new Map(truth.map((row) => [row.mentorProfileId, row]));

    let corrected = 0;
    for (const [mentorProfileId, expected] of byMentor) {
      try {
        const mentor = await this.mentors.findById(mentorProfileId);
        if (!mentor) continue;

        if (
          mentor.ratingSum === expected.ratingSum &&
          mentor.ratingCount === expected.ratingCount
        ) {
          continue;
        }

        await this.mentors.setRatingAggregate({
          mentorProfileId,
          ratingSum: expected.ratingSum,
          ratingCount: expected.ratingCount,
        });
        corrected += 1;

        // WARN, not LOG. A correction means the transactional path failed somewhere, and the
        // number this fixed is less interesting than the fact that it needed fixing.
        this.logger.warn({
          event: 'review.rating_drift_corrected',
          mentorProfileId,
          storedSum: mentor.ratingSum,
          storedCount: mentor.ratingCount,
          derivedSum: expected.ratingSum,
          derivedCount: expected.ratingCount,
        });
      } catch (error) {
        // Per-mentor isolation: one bad row must not abort the sweep and leave the rest
        // undetected.
        this.logger.error(
          `Failed to reconcile rating for mentor ${mentorProfileId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.logger.log({
      event: 'review.rating_reconciled',
      scanned: byMentor.size,
      corrected,
    });
    return { scanned: byMentor.size, corrected };
  }
}
