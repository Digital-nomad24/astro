/**
 * Wire-level enums shared by the API, the web client, and the Prisma schema.
 *
 * These are declared as `as const` arrays first so they can be used at runtime by
 * `class-validator`'s `@IsIn(...)` and by socket DTOs, and as union types second. Keep the
 * members byte-identical to the Prisma enums in `apps/astro-api/prisma/models/enums.prisma`
 * — nothing enforces that automatically, so a mismatch is a runtime 500, not a build error.
 */

export const ROLES = ['USER', 'MENTOR', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

/**
 * How the account first authenticated, derived from the Firebase ID token's
 * `firebase.sign_in_provider` claim.
 *
 * Both email/password and Google sign-in arrive through the SAME server code path — the
 * client completes the flow with the Firebase SDK and sends us the resulting ID token, and we
 * verify it identically either way. This field is a record of provenance, not a branch: the
 * server never runs an OAuth flow of its own and holds no OAuth client secret.
 */
export const AUTH_PROVIDERS = ['EMAIL_PASSWORD', 'GOOGLE', 'PHONE', 'OTHER'] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

/** Maps the Firebase `sign_in_provider` claim onto our enum. */
export function authProviderFromSignInProvider(signInProvider: string | undefined): AuthProvider {
  switch (signInProvider) {
    case 'password':
      return 'EMAIL_PASSWORD';
    case 'google.com':
      return 'GOOGLE';
    case 'phone':
      return 'PHONE';
    default:
      return 'OTHER';
  }
}

/**
 * `VIDEO` is reserved: it exists in the enum so enabling it later is a grant change rather
 * than a migration under load, but the API rejects it with `MODE_NOT_SUPPORTED` in v1.
 */
export const SESSION_MODES = ['VOICE', 'TEXT', 'VIDEO'] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

/** The modes `POST /sessions` will actually accept today. */
export const SUPPORTED_SESSION_MODES = ['VOICE', 'TEXT'] as const;
export type SupportedSessionMode = (typeof SUPPORTED_SESSION_MODES)[number];

export const SESSION_STATUSES = [
  'QUEUED',
  'RINGING',
  'ACTIVE',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * Statuses that occupy a MENTOR. `session_one_inflight_per_mentor` keys off exactly these.
 *
 * QUEUED is deliberately absent: many users queue for one mentor, and that is the entire point
 * of the queue. What a mentor can have only one of is a session that is ringing or running.
 */
export const INFLIGHT_SESSION_STATUSES = ['RINGING', 'ACTIVE'] as const;

/**
 * Statuses that occupy a USER. `session_one_inflight_per_user` keys off these.
 *
 * QUEUED *is* included: a user may wait in at most one queue at a time. Without it, one person
 * could hold a place in every mentor's line and be promoted into several calls at once, and
 * each of those promotions would be perfectly valid on its own.
 */
export const USER_ENGAGED_SESSION_STATUSES = ['QUEUED', 'RINGING', 'ACTIVE'] as const;

export const SESSION_END_REASONS = [
  'COMPLETED_BY_USER',
  'COMPLETED_BY_MENTOR',
  'BALANCE_EXHAUSTED',
  'MAX_DURATION_REACHED',
  'IDLE_TIMEOUT',
  'RING_TIMEOUT',
  'DECLINED',
  'CANCELLED_BY_USER',
  'MENTOR_OFFLINE',
  'QUEUE_EXPIRED',
  'MEDIA_FAILURE',
  'ADMIN_TERMINATED',
] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

export const PRESENCE_STATES = ['OFFLINE', 'ONLINE', 'BUSY'] as const;
export type PresenceState = (typeof PRESENCE_STATES)[number];

export const QUEUE_ENTRY_STATUSES = [
  'WAITING',
  'PROMOTED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type QueueEntryStatus = (typeof QUEUE_ENTRY_STATUSES)[number];

export const MENTOR_APPROVAL_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'SUSPENDED',
] as const;
export type MentorApprovalStatus = (typeof MENTOR_APPROVAL_STATUSES)[number];

/** Only an APPROVED mentor may appear in the catalogue or take a session. */
export const BOOKABLE_MENTOR_APPROVAL_STATUS = 'APPROVED' as const;

/**
 * Browse ordering. Deliberately a closed set rather than a free-form `sortBy` string: every
 * option here is backed by an index, and an unindexed sort over the mentor catalogue is a
 * sequential scan on the hottest read path in the product.
 */
export const MENTOR_SORT_OPTIONS = ['RATING', 'PRICE_ASC', 'PRICE_DESC', 'NEWEST'] as const;
export type MentorSort = (typeof MENTOR_SORT_OPTIONS)[number];
