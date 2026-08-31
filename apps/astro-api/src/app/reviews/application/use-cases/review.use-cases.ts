import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MentorRatingSummary, ReviewView } from '@astro/contracts';
import { ConflictError, NotFoundError, ValidationError } from '@astro/errors';

import type { EnvVars } from '../../../../config/env.schema';
import { decodeCursor, encodeCursor, toPage, type Page } from '../../../common/pagination/cursor';
import type { AuthenticatedUser } from '../../../identity/contracts/authenticated-user';
import type { IMentorProfileRepo } from '../../../mentors/domain/repos/mentor.repos';
import { MENTOR_PROFILE_REPO } from '../../../mentors/tokens';
import { SessionLifecycleService } from '../../../sessions/application/services/session-lifecycle.service';
import type { IReviewRecord, IReviewRepo } from '../../domain/repos/review.repos';
import { REVIEW_REPO } from '../../tokens';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SubmitReviewInput {
  readonly rating: number;
  readonly comment?: string | null;
}

/**
 * Rate a consultation.
 *
 * Deliberately an upsert rather than create-only. A misclicked star is the single most common
 * thing a user wants to change about a review, and refusing the edit pushes them toward
 * deleting and re-rating — which in a system where the count is denormalised is strictly worse
 * to get right than an in-place adjustment.
 */
@Injectable()
export class SubmitReviewUseCase {
  private readonly logger = new Logger(SubmitReviewUseCase.name);
  private readonly windowDays: number;

  constructor(
    @Inject(REVIEW_REPO) private readonly reviews: IReviewRepo,
    private readonly sessions: SessionLifecycleService,
    config: ConfigService<EnvVars, true>,
  ) {
    this.windowDays = config.get('REVIEW_WINDOW_DAYS', { infer: true });
  }

  async execute(
    user: AuthenticatedUser,
    sessionId: string,
    input: SubmitReviewInput,
  ): Promise<ReviewView> {
    const session = await this.sessions.requireParticipant(sessionId, user);

    // Only the consumer rates. A mentor rating their caller is a different feature with
    // different moderation needs, and folding it in would make "the rating" ambiguous.
    if (session.userId !== user.id) {
      throw new ConflictError(
        'NOT_THE_CALLER',
        'Only the person who booked the consultation can review it.',
      );
    }

    // A consultation that never connected has nothing to rate. `billingAnchorAt` is the one
    // signal that both parties were actually present — status COMPLETED alone includes
    // sessions an admin terminated before anyone spoke.
    if (session.status !== 'COMPLETED' || !session.billingAnchorAt) {
      throw new ConflictError(
        'SESSION_NOT_REVIEWABLE',
        'You can only review a consultation that took place.',
      );
    }

    const endedAt = session.endedAt?.getTime() ?? 0;
    if (Date.now() - endedAt > this.windowDays * DAY_MS) {
      // Bounded so the aggregate reflects recent service, and so an old session cannot be
      // dredged up to rating-bomb a mentor months later.
      throw new ConflictError(
        'REVIEW_WINDOW_CLOSED',
        `Reviews close ${this.windowDays} days after a consultation ends.`,
        { windowDays: this.windowDays },
      );
    }

    const comment = input.comment?.trim() ?? null;
    if (comment !== null && comment.length > 2000) {
      throw new ValidationError('COMMENT_TOO_LONG', 'A review may be at most 2000 characters.');
    }

    const result = await this.reviews.upsert({
      sessionId,
      mentorProfileId: session.mentorProfileId,
      authorUserId: user.id,
      authorDisplayName: user.displayName,
      rating: input.rating,
      comment: comment && comment.length > 0 ? comment : null,
    });

    this.logger.log({
      event: result.created ? 'review.created' : 'review.updated',
      sessionId,
      mentorProfileId: session.mentorProfileId,
      rating: input.rating,
    });

    return toReviewView(result.review, user.id);
  }
}

@Injectable()
export class GetSessionReviewUseCase {
  constructor(
    @Inject(REVIEW_REPO) private readonly reviews: IReviewRepo,
    private readonly sessions: SessionLifecycleService,
  ) {}

  async execute(user: AuthenticatedUser, sessionId: string): Promise<ReviewView | null> {
    // Authorised as a participant: both sides may read the review of their own consultation,
    // which is what lets a mentor see feedback without exposing it to anyone else.
    await this.sessions.requireParticipant(sessionId, user);

    const review = await this.reviews.findBySessionId(sessionId);
    // A hidden review is invisible even to its author — see the note on `listForMentor`.
    if (!review || review.isHidden) return null;
    return toReviewView(review, user.id);
  }
}

export interface ListMentorReviewsInput {
  readonly limit?: number;
  readonly cursor?: string;
}

@Injectable()
export class ListMentorReviewsUseCase {
  constructor(
    @Inject(REVIEW_REPO) private readonly reviews: IReviewRepo,
    @Inject(MENTOR_PROFILE_REPO) private readonly mentors: IMentorProfileRepo,
  ) {}

  async execute(
    user: AuthenticatedUser,
    mentorProfileId: string,
    input: ListMentorReviewsInput,
  ): Promise<Page<ReviewView>> {
    const mentor = await this.mentors.findById(mentorProfileId);
    // Matches the catalogue: a mentor who is not bookable is not discoverable either, reviews
    // included.
    if (!mentor || mentor.approvalStatus !== 'APPROVED') {
      throw new NotFoundError('MENTOR_NOT_FOUND', 'That mentor is not available.');
    }

    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    const rows = await this.reviews.listForMentor(mentorProfileId, limit, cursor);

    return toPage(
      rows.map((row) => toReviewView(row, user.id)),
      limit,
      (view) => ({ v: view.createdAt, id: view.id }),
    );
  }
}

/** The histogram on a mentor's profile, read straight from the reviews rather than the cache. */
@Injectable()
export class GetMentorRatingUseCase {
  constructor(
    @Inject(REVIEW_REPO) private readonly reviews: IReviewRepo,
    @Inject(MENTOR_PROFILE_REPO) private readonly mentors: IMentorProfileRepo,
  ) {}

  async execute(mentorProfileId: string): Promise<MentorRatingSummary> {
    const mentor = await this.mentors.findById(mentorProfileId);
    if (!mentor || mentor.approvalStatus !== 'APPROVED') {
      throw new NotFoundError('MENTOR_NOT_FOUND', 'That mentor is not available.');
    }

    const distribution = await this.reviews.distributionFor(mentorProfileId);
    return {
      // The denormalised values, not a recount — this is the number the browse card sorts on,
      // so a profile page showing something different would be the bug worth surfacing.
      ratingAvg: mentor.ratingAvg,
      ratingCount: mentor.ratingCount,
      distribution: {
        1: distribution[1] ?? 0,
        2: distribution[2] ?? 0,
        3: distribution[3] ?? 0,
        4: distribution[4] ?? 0,
        5: distribution[5] ?? 0,
      },
    };
  }
}

@Injectable()
export class ModerateReviewUseCase {
  private readonly logger = new Logger(ModerateReviewUseCase.name);

  constructor(@Inject(REVIEW_REPO) private readonly reviews: IReviewRepo) {}

  async execute(
    admin: AuthenticatedUser,
    reviewId: string,
    hidden: boolean,
    reason: string | null,
  ): Promise<{ changed: boolean }> {
    const review = await this.reviews.setHidden({
      reviewId,
      hidden,
      reason,
      byUserId: admin.id,
    });

    // Null means it was already in this state. Reported as `changed: false` rather than an
    // error: a second click on "hide" should be a no-op, not a failure.
    if (!review) return { changed: false };

    this.logger.warn({
      event: hidden ? 'review.hidden' : 'review.unhidden',
      reviewId,
      mentorProfileId: review.mentorProfileId,
      byUserId: admin.id,
      reason,
    });
    return { changed: true };
  }
}

export const toReviewView = (record: IReviewRecord, viewerUserId: string): ReviewView => ({
  id: record.id,
  sessionId: record.sessionId,
  mentorProfileId: record.mentorProfileId,
  rating: record.rating,
  comment: record.comment,
  authorDisplayName: record.authorDisplayName,
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
  isMine: record.authorUserId === viewerUserId,
});

export { encodeCursor };
