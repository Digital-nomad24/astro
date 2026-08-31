import type { PageCursor } from '../../../common/pagination/cursor';

export interface IReviewRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly mentorProfileId: string;
  readonly authorUserId: string;
  readonly authorDisplayName: string | null;
  readonly rating: number;
  readonly comment: string | null;
  readonly isHidden: boolean;
  readonly hiddenReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface IUpsertReviewParams {
  readonly sessionId: string;
  readonly mentorProfileId: string;
  readonly authorUserId: string;
  readonly authorDisplayName: string | null;
  readonly rating: number;
  readonly comment: string | null;
}

export interface IUpsertReviewResult {
  readonly review: IReviewRecord;
  /** False when this replaced an existing review — the count is unchanged, the sum is not. */
  readonly created: boolean;
}

/** One mentor's rating, re-derived from the reviews themselves. */
export interface IRatingTruth {
  readonly mentorProfileId: string;
  readonly ratingSum: number;
  readonly ratingCount: number;
}

export interface IReviewRepo {
  /**
   * Writes the review AND the mentor's rating aggregate in one transaction.
   *
   * They cannot be separated. `MentorProfile.ratingAvg` is a browse sort key, so a window in
   * which it disagrees with the reviews is a window in which mentors are ranked wrongly on the
   * hottest read path in the product — and nothing would notice until the nightly reconciler.
   *
   * An edit adjusts the sum by the difference and leaves the count alone, which is why the
   * previous rating has to be read inside the same transaction rather than trusted from the
   * caller.
   */
  upsert(params: IUpsertReviewParams): Promise<IUpsertReviewResult>;

  findBySessionId(sessionId: string): Promise<IReviewRecord | null>;

  /** A mentor's visible reviews, newest first. Returns `limit + 1` to detect another page. */
  listForMentor(
    mentorProfileId: string,
    limit: number,
    cursor: PageCursor | null,
  ): Promise<IReviewRecord[]>;

  /** How many reviews sit at each star. Drives the histogram on a mentor's profile. */
  distributionFor(mentorProfileId: string): Promise<Record<number, number>>;

  /**
   * Hides or unhides a review, adjusting the aggregate in the same transaction. Returns null
   * when the review was already in the requested state — nothing to do, and applying the delta
   * anyway would double-count it.
   */
  setHidden(params: {
    readonly reviewId: string;
    readonly hidden: boolean;
    readonly reason: string | null;
    readonly byUserId: string;
  }): Promise<IReviewRecord | null>;

  /**
   * The reconciler's source of truth: sum and count re-derived from visible reviews, for every
   * mentor that has any. Mentors with none are absent and are handled by the caller.
   */
  deriveRatingTruth(): Promise<IRatingTruth[]>;
}
