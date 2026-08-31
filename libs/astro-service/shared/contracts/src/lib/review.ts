/** Ratings are whole stars. A half-star scale is a client concern, not a storage one. */
export const RATING_MIN = 1 as const;
export const RATING_MAX = 5 as const;

export interface ReviewView {
  readonly id: string;
  readonly sessionId: string;
  readonly mentorProfileId: string;
  readonly rating: number;
  readonly comment: string | null;
  /**
   * The reviewer's display name at the time of writing, or null if they had none.
   *
   * A **copy**, not a join. A review outlives the account that wrote it — the mentor's rating
   * would otherwise change when a user deletes themselves — and it must still say who said it.
   */
  readonly authorDisplayName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** True when the caller wrote this one, so a client can offer to edit it. */
  readonly isMine: boolean;
}

/** The aggregate a browse card renders. Denormalised onto `MentorProfile`. */
export interface MentorRatingSummary {
  readonly ratingAvg: number;
  readonly ratingCount: number;
  /** How many reviews sit at each star, 1 through 5. */
  readonly distribution: Readonly<Record<1 | 2 | 3 | 4 | 5, number>>;
}
