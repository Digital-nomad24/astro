import type { SessionEndReason, SessionMode, SessionStatus } from './enums';

/**
 * A session as any client sees it.
 *
 * Timestamps are ISO strings, not epoch millis, because these cross the HTTP boundary where
 * JSON has no date type and a bare number is ambiguous about its unit. The one exception is
 * `ringExpiresAtMs` on the socket payloads, which drives a countdown and is compared against
 * a clock rather than displayed.
 *
 * `ratePaisePerMinute` is the rate FROZEN on this session, not the mentor's current rate.
 * Showing the live rate on a call in progress would be a lie the moment the mentor edits it.
 */
export interface SessionView {
  readonly id: string;
  readonly mode: SessionMode;
  readonly status: SessionStatus;

  readonly userId: string;
  /**
   * The caller's name, as the **mentor** needs to render it: on the incoming ring and on every
   * row of their session history, both of which otherwise read "Consultation" for everyone.
   *
   * Nullable because `User.displayName` is — onboarding sets it, but the column allows null and
   * a history row must survive an account that never finished. Clients fall back to "Guest".
   */
  readonly userDisplayName: string | null;
  readonly mentorProfileId: string;
  readonly mentorUserId: string;
  readonly mentorDisplayName: string;

  readonly ratePaisePerMinute: number;
  readonly platformFeeBps: number;

  readonly createdAt: string;
  readonly ringingAt: string | null;
  readonly acceptedAt: string | null;
  /**
   * When metering starts. For VOICE this is stamped from the `participant_joined` webhook for
   * the SECOND party — a mentor does not bill for the user sitting alone in a room. Null until
   * both sides are actually connected.
   */
  readonly billingAnchorAt: string | null;
  readonly endedAt: string | null;
  readonly endReason: SessionEndReason | null;

  /** Wall-clock seconds from the anchor. Null before the anchor exists. */
  readonly billedSeconds: number | null;

  /** Recording consent is per-party and per-session; both are required before any egress. */
  readonly recordingConsentUser: boolean;
  readonly recordingConsentMentor: boolean;

  /**
   * How many messages the conversation held. Survives the transcript's deletion on purpose, so
   * a history row can still say "14 messages" after the text itself is gone.
   */
  readonly messageCount: number;
  /**
   * When the transcript was deleted, or null while it is still retained. A client needs this
   * to distinguish "no messages" from "the messages are gone" — the same empty list otherwise.
   */
  readonly transcriptPurgedAt: string | null;

  /**
   * The rating left for this consultation, or null if it has not been reviewed.
   *
   * Carried on the session so a history list can show "rate this" without a request per row.
   * Both participants see it: the mentor's own feedback is not something to hide from them.
   */
  readonly rating: number | null;
}

/**
 * What a client needs to connect its media transport. Issued per participant, per session.
 *
 * Re-issuable: a refresh or a network change asks for these again rather than being stuck
 * with the token handed out at accept time.
 */
export interface CallJoinCredentials {
  readonly sessionId: string;
  /** The `wss://` URL the browser SDK connects to — not the HTTP host the server API uses. */
  readonly url: string;
  readonly token: string;
  readonly identity: string;
  readonly roomName: string;
  readonly expiresAtMs: number;
}

/** Terminal statuses. A session in one of these will never change again. */
export const TERMINAL_SESSION_STATUSES = ['COMPLETED', 'CANCELLED', 'FAILED'] as const;

export function isTerminalSessionStatus(status: SessionStatus): boolean {
  return (TERMINAL_SESSION_STATUSES as readonly string[]).includes(status);
}
