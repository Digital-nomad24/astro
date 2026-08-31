import type { MentorApprovalStatus, MentorSort, PresenceState } from '@astro/contracts';

import type { PageCursor } from '../../../common/pagination/cursor';

export interface IMentorCategoryRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly iconUrl: string | null;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

export interface IMentorProfileRecord {
  readonly id: string;
  readonly userId: string;
  readonly categoryId: string;
  readonly categorySlug: string;
  readonly categoryName: string;
  readonly displayName: string;
  readonly headline: string | null;
  readonly bio: string | null;
  readonly languages: readonly string[];
  readonly experienceYears: number;
  readonly ratePaisePerMinute: number;
  readonly approvalStatus: MentorApprovalStatus;
  readonly approvalNote: string | null;
  readonly approvedAt: Date | null;
  readonly presenceState: PresenceState;
  readonly acceptingNewCalls: boolean;
  readonly queueDepth: number;
  readonly ratingAvg: number;
  readonly ratingCount: number;
  /** Exposed so the drift reconciler can compare the cache against the reviews it caches. */
  readonly ratingSum: number;
  readonly totalSessions: number;
  readonly createdAt: Date;
}

export interface IMentorListFilters {
  readonly categoryId?: string;
  readonly onlineOnly?: boolean;
  readonly maxRatePaisePerMinute?: number;
  readonly language?: string;
  readonly search?: string;
  readonly sort: MentorSort;
  readonly limit: number;
  readonly cursor: PageCursor | null;
}

export interface ICreateMentorProfileParams {
  readonly userId: string;
  readonly categoryId: string;
  readonly displayName: string;
  readonly headline?: string | null;
  readonly bio?: string | null;
  readonly languages: string[];
  readonly experienceYears: number;
  readonly ratePaisePerMinute: number;
}

export interface IUpdateMentorProfileParams {
  readonly categoryId?: string;
  readonly displayName?: string;
  readonly headline?: string | null;
  readonly bio?: string | null;
  readonly languages?: string[];
  readonly experienceYears?: number;
  readonly ratePaisePerMinute?: number;
}

export interface IReviewApplicationParams {
  readonly mentorProfileId: string;
  readonly status: MentorApprovalStatus;
  readonly note: string | null;
  readonly reviewedByUserId: string;
}

export interface IMentorCategoryRepo {
  listActive(): Promise<IMentorCategoryRecord[]>;
  findBySlug(slug: string): Promise<IMentorCategoryRecord | null>;
  findById(id: string): Promise<IMentorCategoryRecord | null>;
  create(params: Omit<IMentorCategoryRecord, 'id'>): Promise<IMentorCategoryRecord>;
  update(
    id: string,
    params: Partial<Omit<IMentorCategoryRecord, 'id' | 'slug'>>,
  ): Promise<IMentorCategoryRecord>;
}

export interface IMentorProfileRepo {
  /** Catalogue browse. Returns `limit + 1` rows so the caller can detect a next page. */
  listBookable(filters: IMentorListFilters): Promise<IMentorProfileRecord[]>;
  /** Moderation queue — any approval status, oldest first. */
  listByApprovalStatus(
    status: MentorApprovalStatus,
    limit: number,
    cursor: PageCursor | null,
  ): Promise<IMentorProfileRecord[]>;
  findById(id: string): Promise<IMentorProfileRecord | null>;
  findByUserId(userId: string): Promise<IMentorProfileRecord | null>;
  create(params: ICreateMentorProfileParams): Promise<IMentorProfileRecord>;
  update(id: string, params: IUpdateMentorProfileParams): Promise<IMentorProfileRecord>;
  reviewApplication(params: IReviewApplicationParams): Promise<IMentorProfileRecord>;

  /**
   * Sync the presence READ MODEL. Redis remains the live truth; this column exists so the
   * browse query stays one indexed Postgres read instead of N Redis lookups per page.
   *
   * Deliberately returns void and is safe to lose: if this write fails, presence is briefly
   * stale on browse cards but no live behaviour is wrong, and the next transition or the
   * sweeper corrects it.
   */
  updatePresence(params: IUpdatePresenceParams): Promise<void>;

  /**
   * Accumulates one completed session into the mentor's history.
   *
   * These two counters are what turn the M6 queue ETA from a flat constant into an estimate
   * based on how long this particular mentor's consultations actually run. Called only for
   * sessions that connected — a declined call has no duration to average.
   */
  recordCompletedSession(mentorProfileId: string, billedSeconds: number): Promise<void>;

  /** Average session length in seconds, or null before there is any history to average. */
  averageSessionSeconds(mentorProfileId: string): Promise<number | null>;

  /**
   * Applies a change to the denormalised rating aggregate.
   *
   * Deltas rather than absolutes, and `ratingAvg` recomputed from the post-update sum and count
   * **inside the same statement** — so two reviews landing at once both count, and the average
   * can never be observed disagreeing with the sum it came from. A read-modify-write here
   * would silently lose one of them, and the loss would only show up in the nightly drift
   * report.
   *
   * Must be called with the review write in one transaction. `ratingAvg` is a browse sort key;
   * a mentor whose stored average and stored reviews disagree is sorted into the wrong place
   * on the hottest read path in the product.
   */
  applyRatingDelta(params: IRatingDeltaParams): Promise<void>;

  /** Overwrites the aggregate outright. Only the drift reconciler may use this. */
  setRatingAggregate(params: {
    readonly mentorProfileId: string;
    readonly ratingSum: number;
    readonly ratingCount: number;
  }): Promise<void>;
}

export interface IRatingDeltaParams {
  readonly mentorProfileId: string;
  /** Signed. An edit from 2 stars to 5 is `+3` with a count delta of 0. */
  readonly sumDelta: number;
  /** `+1` for a new review, `-1` when one is hidden or removed, `0` for an edit. */
  readonly countDelta: number;
}

export interface IUpdatePresenceParams {
  readonly mentorProfileId: string;
  readonly presenceState: PresenceState;
  readonly acceptingNewCalls?: boolean;
  readonly queueDepth?: number;
}
