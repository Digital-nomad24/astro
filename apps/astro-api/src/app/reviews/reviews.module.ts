import { Module } from '@nestjs/common';

import { MentorsModule } from '../mentors/mentors.module';
import { SessionsModule } from '../sessions/sessions.module';
import { RatingReconcilerScheduler } from './application/schedulers/rating-reconciler.scheduler';
import {
  GetMentorRatingUseCase,
  GetSessionReviewUseCase,
  ListMentorReviewsUseCase,
  ModerateReviewUseCase,
  SubmitReviewUseCase,
} from './application/use-cases/review.use-cases';
import { AdminReviewsController, ReviewsController } from './entry-points/http/reviews.controller';
import { ReviewPrismaRepo } from './infra/db/prisma/repos/review.prisma.repo';
import { REVIEW_REPO } from './tokens';

/**
 * Depends only on sessions and mentors — nothing depends on reviews.
 *
 * `SessionLifecycleService` supplies the participant check, so the authorisation rule for "may
 * I review this?" is the same one that decides "may I read this session?", stated once.
 */
@Module({
  imports: [SessionsModule, MentorsModule],
  controllers: [ReviewsController, AdminReviewsController],
  providers: [
    SubmitReviewUseCase,
    GetSessionReviewUseCase,
    ListMentorReviewsUseCase,
    GetMentorRatingUseCase,
    ModerateReviewUseCase,
    RatingReconcilerScheduler,
    { provide: REVIEW_REPO, useClass: ReviewPrismaRepo },
  ],
  exports: [REVIEW_REPO],
})
export class ReviewsModule {}
