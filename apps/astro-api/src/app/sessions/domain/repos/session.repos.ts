import type { SessionEndReason, SessionMode, SessionStatus } from '@astro/contracts';

import type { PageCursor } from '../../../common/pagination/cursor';

export interface ISessionRecord {
  readonly id: string;
  readonly mode: SessionMode;
  readonly status: SessionStatus;

  readonly userId: string;
  /** Nullable, mirroring `User.displayName`. See `SessionView.userDisplayName`. */
  readonly userDisplayName: string | null;
  readonly mentorProfileId: string;
  readonly mentorUserId: string;
  readonly mentorDisplayName: string;

  readonly ratePaisePerMinute: number;
  readonly platformFeeBps: number;

  readonly createdAt: Date;
  readonly ringingAt: Date | null;
  readonly acceptedAt: Date | null;
  readonly billingAnchorAt: Date | null;
  readonly endedAt: Date | null;
  readonly endReason: SessionEndReason | null;

  readonly livekitRoomName: string | null;
  readonly livekitRoomSid: string | null;
  readonly participantJoinCount: number;
  readonly connectedIdentities: readonly string[];

  readonly recordingConsentUserAt: Date | null;
  readonly recordingConsentMentorAt: Date | null;
  readonly egressId: string | null;
  readonly summaryIneligibleReason: string | null;

  /**
   * Chat columns (M5). Written only by `IChatMessageRepo`, which owns them — they live on this
   * row so the idle and retention sweeps are single indexed scans. Readable here because the
   * session view needs them; `ISessionRepo` never writes them.
   */
  readonly lastMessageAt: Date | null;
  readonly messageCount: number;
  readonly messagesPurgedAt: Date | null;

  /** The rating for this consultation (M7), or null if unreviewed or hidden. */
  readonly rating: number | null;
}

export interface ICreateSessionParams {
  readonly userId: string;
  readonly mentorProfileId: string;
  readonly mentorUserId: string;
  readonly mode: SessionMode;
  readonly status: SessionStatus;
  /** Frozen copies of the mentor's economics. Never re-read during the session's life. */
  readonly ratePaisePerMinute: number;
  readonly platformFeeBps: number;
  /** Reserved at creation for VOICE, null for TEXT. The room itself is created after. */
  readonly livekitRoomName: string | null;
  readonly ringingAt: Date | null;
}

export interface ITransitionParams {
  readonly sessionId: string;
  /**
   * The statuses this transition is allowed to move *from*. The update is scoped to these, so
   * a row that has moved on is not touched and the caller is told it lost the race.
   */
  readonly from: readonly SessionStatus[];
  readonly to: SessionStatus;
  /** Required when `to` is terminal — the DB CHECK rejects a terminal row without one. */
  readonly endReason?: SessionEndReason;
  readonly at?: Date;
}

export interface IParticipantPresenceParams {
  readonly sessionId: string;
  readonly identity: string;
}

export type ConsentParty = 'USER' | 'MENTOR';

export interface ISessionRepo {
  /**
   * Inserts the session row.
   *
   * Throws `ConflictError('SESSION_ALREADY_IN_FLIGHT')` when the partial unique index rejects
   * it — that is the designed outcome of two callers racing for the same mentor, not an
   * exceptional one.
   */
  create(params: ICreateSessionParams): Promise<ISessionRecord>;

  findById(id: string): Promise<ISessionRecord | null>;
  findByRoomName(roomName: string): Promise<ISessionRecord | null>;

  /** The single RINGING-or-ACTIVE session, if any. The partial unique index guarantees ≤ 1. */
  findInflightForUser(userId: string): Promise<ISessionRecord | null>;
  findInflightForMentor(mentorProfileId: string): Promise<ISessionRecord | null>;

  listForUser(userId: string, limit: number, cursor: PageCursor | null): Promise<ISessionRecord[]>;
  listForMentor(
    mentorProfileId: string,
    limit: number,
    cursor: PageCursor | null,
  ): Promise<ISessionRecord[]>;

  /**
   * Compare-and-swap. Returns the updated row, or **null when someone else won the race** —
   * the ring-timeout sweeper and the mentor's accept routinely collide at second 30, and
   * exactly one of them must take effect.
   */
  transition(params: ITransitionParams): Promise<ISessionRecord | null>;

  /**
   * Stamps `billingAnchorAt` only if it is still null. Returns true when THIS call stamped it.
   *
   * The return value is the interesting part: a duplicate `participant_joined` webhook, or a
   * rejoin after a network drop, must not move the meter's origin backwards or forwards. The
   * caller uses the false to know it is looking at a repeat and should not re-announce the
   * call as newly connected.
   */
  stampBillingAnchor(sessionId: string, at: Date): Promise<boolean>;

  attachRoom(sessionId: string, roomName: string, roomSid: string): Promise<void>;

  /** Records an arrival: bumps `participantJoinCount` and adds the identity if new. */
  recordParticipantJoined(params: IParticipantPresenceParams): Promise<ISessionRecord | null>;
  recordParticipantLeft(params: IParticipantPresenceParams): Promise<ISessionRecord | null>;

  /** Stamp-only-if-null, like the anchor: consent is given once and cannot be re-timed. */
  recordConsent(sessionId: string, party: ConsentParty, at: Date): Promise<ISessionRecord | null>;

  markSummaryIneligible(sessionId: string, reason: string): Promise<void>;

  /** RINGING for longer than the ring timeout. */
  findRingingBefore(cutoff: Date, limit: number): Promise<ISessionRecord[]>;
  /**
   * VOICE sessions that are ACTIVE but still un-anchored past the media-establish timeout —
   * the mentor accepted, but the two sides never both connected.
   *
   * **Scoped to VOICE, and that is not an optimisation.** A text session is un-anchored until
   * the first message, and forty-five seconds of silence at the start of a written
   * conversation is completely normal — someone is typing. Sweeping text here would kill live
   * consultations. Text's equivalent backstop is the idle timeout, which is minutes and
   * measured from the last message rather than from accept.
   */
  findActiveVoiceWithoutAnchorBefore(cutoff: Date, limit: number): Promise<ISessionRecord[]>;
  /** ACTIVE past the hard duration cap. Until M10 this is the only stop on a running call. */
  findActiveAnchoredBefore(cutoff: Date, limit: number): Promise<ISessionRecord[]>;
}

export interface IWebhookEventRecord {
  readonly id: string;
  readonly source: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly roomName: string | null;
  readonly participantIdentity: string | null;
  readonly sessionId: string | null;
  readonly payload: unknown;
  readonly receivedAt: Date;
  readonly processedAt: Date | null;
  readonly attempts: number;
  readonly lastError: string | null;
}

export interface IRecordWebhookEventParams {
  readonly source: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly roomName: string | null;
  readonly participantIdentity: string | null;
  readonly sessionId: string | null;
  readonly payload: unknown;
}

export interface IWebhookEventRepo {
  /**
   * Writes the event to the inbox.
   *
   * `isNew: false` means this exact event id was already accepted — a redelivery, which
   * LiveKit does routinely. The caller returns 200 and does nothing, which is what makes
   * duplicate delivery a no-op rather than a double state transition.
   */
  record(
    params: IRecordWebhookEventParams,
  ): Promise<{ readonly isNew: boolean; readonly event: IWebhookEventRecord }>;

  markProcessed(id: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;

  /** Unprocessed events for the retry sweep, oldest first, below the attempt ceiling. */
  findUnprocessed(limit: number, maxAttempts: number): Promise<IWebhookEventRecord[]>;
}
