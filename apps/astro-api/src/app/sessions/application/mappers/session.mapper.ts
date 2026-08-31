import type { SessionView } from '@astro/contracts';

import type { ISessionRecord } from '../../domain/repos/session.repos';

/**
 * Row → wire.
 *
 * `billedSeconds` is derived here rather than stored, because a live session's duration is a
 * function of the clock and any stored copy is stale the instant it is written. For an ended
 * session it is pinned to `endedAt`, so the number stops moving the moment the call does.
 */
export function toSessionView(record: ISessionRecord, now: Date = new Date()): SessionView {
  return {
    id: record.id,
    mode: record.mode,
    status: record.status,
    userId: record.userId,
    userDisplayName: record.userDisplayName,
    mentorProfileId: record.mentorProfileId,
    mentorUserId: record.mentorUserId,
    mentorDisplayName: record.mentorDisplayName,
    ratePaisePerMinute: record.ratePaisePerMinute,
    platformFeeBps: record.platformFeeBps,
    createdAt: record.createdAt.toISOString(),
    ringingAt: record.ringingAt?.toISOString() ?? null,
    acceptedAt: record.acceptedAt?.toISOString() ?? null,
    billingAnchorAt: record.billingAnchorAt?.toISOString() ?? null,
    endedAt: record.endedAt?.toISOString() ?? null,
    endReason: record.endReason,
    billedSeconds: billedSeconds(record, now),
    recordingConsentUser: record.recordingConsentUserAt !== null,
    recordingConsentMentor: record.recordingConsentMentorAt !== null,
    messageCount: record.messageCount,
    transcriptPurgedAt: record.messagesPurgedAt?.toISOString() ?? null,
    rating: record.rating,
  };
}

/**
 * Wall-clock seconds since the anchor. Null before both parties connected — a session that
 * never started has no duration, and reporting 0 would be indistinguishable from one that
 * started and was cut off instantly.
 *
 * Clamped at zero rather than trusted: `billingAnchorAt` for a voice call comes from LiveKit's
 * clock, and a skewed one could otherwise produce a negative duration on screen. This is the
 * display path — M10's ledger does its own clamping against its own guards.
 */
export function billedSeconds(record: ISessionRecord, now: Date): number | null {
  if (!record.billingAnchorAt) return null;
  const until = record.endedAt ?? now;
  return Math.max(0, Math.floor((until.getTime() - record.billingAnchorAt.getTime()) / 1000));
}
