import type { MentorApprovalStatus, PresenceState } from '@astro/contracts';

import type { IMentorCategoryRecord, IMentorProfileRecord } from '../../domain/repos/mentor.repos';

/** A browse card. Deliberately smaller than the detail view — this ships 20 at a time. */
export interface MentorCardResponse {
  id: string;
  displayName: string;
  headline: string | null;
  categorySlug: string;
  categoryName: string;
  languages: readonly string[];
  experienceYears: number;
  ratePaisePerMinute: number;
  presenceState: PresenceState;
  acceptingNewCalls: boolean;
  queueDepth: number;
  ratingAvg: number;
  ratingCount: number;
  totalSessions: number;
}

export interface MentorDetailResponse extends MentorCardResponse {
  bio: string | null;
  memberSince: string;
}

/** The mentor's own view: adds moderation state they are entitled to see about themselves. */
export interface MyMentorProfileResponse extends MentorDetailResponse {
  approvalStatus: MentorApprovalStatus;
  approvalNote: string | null;
  approvedAt: string | null;
  isBookable: boolean;
}

export interface MentorCategoryResponse {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
}

/**
 * Note what is absent: `userId`. A mentor's `User.id` is an internal join key, and exposing it
 * on a public browse card would let anyone correlate a mentor with a consumer account.
 * Clients address mentors by `MentorProfile.id`.
 */
export const toMentorCard = (record: IMentorProfileRecord): MentorCardResponse => ({
  id: record.id,
  displayName: record.displayName,
  headline: record.headline,
  categorySlug: record.categorySlug,
  categoryName: record.categoryName,
  languages: record.languages,
  experienceYears: record.experienceYears,
  ratePaisePerMinute: record.ratePaisePerMinute,
  presenceState: record.presenceState,
  acceptingNewCalls: record.acceptingNewCalls,
  queueDepth: record.queueDepth,
  // Rounded for display; the exact value stays in the sort key, not the payload.
  ratingAvg: Math.round(record.ratingAvg * 10) / 10,
  ratingCount: record.ratingCount,
  totalSessions: record.totalSessions,
});

export const toMentorDetail = (record: IMentorProfileRecord): MentorDetailResponse => ({
  ...toMentorCard(record),
  bio: record.bio,
  memberSince: record.createdAt.toISOString(),
});

export const toMyMentorProfile = (record: IMentorProfileRecord): MyMentorProfileResponse => ({
  ...toMentorDetail(record),
  approvalStatus: record.approvalStatus,
  approvalNote: record.approvalNote,
  approvedAt: record.approvedAt ? record.approvedAt.toISOString() : null,
  // Computed rather than left to the client: "approved AND accepting" is the rule that
  // decides bookability, and it should be stated in exactly one place.
  isBookable: record.approvalStatus === 'APPROVED' && record.acceptingNewCalls,
});

export const toMentorCategory = (record: IMentorCategoryRecord): MentorCategoryResponse => ({
  id: record.id,
  slug: record.slug,
  name: record.name,
  description: record.description,
  iconUrl: record.iconUrl,
});
