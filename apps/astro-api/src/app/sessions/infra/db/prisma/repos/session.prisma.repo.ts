import { Injectable } from '@nestjs/common';
import type { SessionEndReason, SessionMode, SessionStatus } from '@astro/contracts';
import { ConflictError } from '@astro/errors';

import { PrismaService } from 'prisma/prisma.service';
import { isUniqueViolation } from '../../../../../common/db/unique-violation';
import type { PageCursor } from '../../../../../common/pagination/cursor';
import type {
  ConsentParty,
  ICreateSessionParams,
  IParticipantPresenceParams,
  ISessionRecord,
  ISessionRepo,
  ITransitionParams,
} from '../../../../domain/repos/session.repos';
import { isTerminal } from '../../../../domain/entities/session.state-machine';

const WITH_MENTOR = {
  mentorProfile: { select: { displayName: true } },
  // The other half of the pair. Selected, not joined wholesale: a session read must never pull
  // a caller's email or phone number into a payload the mentor receives.
  user: { select: { displayName: true } },
  // A to-one join on a unique index. Carried on every session read so a history list can show
  // "rate this" without a request per row.
  review: { select: { rating: true, isHidden: true } },
} as const;

type SessionRow = {
  id: string;
  mode: SessionMode;
  status: SessionStatus;
  userId: string;
  mentorProfileId: string;
  mentorUserId: string;
  ratePaisePerMinute: number;
  platformFeeBps: number;
  createdAt: Date;
  ringingAt: Date | null;
  acceptedAt: Date | null;
  billingAnchorAt: Date | null;
  endedAt: Date | null;
  endReason: SessionEndReason | null;
  livekitRoomName: string | null;
  livekitRoomSid: string | null;
  participantJoinCount: number;
  connectedIdentities: string[];
  recordingConsentUserAt: Date | null;
  recordingConsentMentorAt: Date | null;
  egressId: string | null;
  summaryIneligibleReason: string | null;
  lastMessageAt: Date | null;
  messageCount: number;
  messagesPurgedAt: Date | null;
  mentorProfile: { displayName: string };
  user: { displayName: string | null };
  review: { rating: number; isHidden: boolean } | null;
};

/**
 * The two partial unique indexes are scoped differently, and so are these lookups.
 *
 * A mentor is occupied by a ringing or running session; a user is occupied by those **and by
 * waiting in a queue**. Using the mentor's set for the user's lookup would mean a queued
 * caller has no in-flight session at all — `calls:resync` would tell them they are not in a
 * call, which for someone staring at a position counter is simply false.
 */
const MENTOR_INFLIGHT: SessionStatus[] = ['RINGING', 'ACTIVE'];
const USER_ENGAGED: SessionStatus[] = ['QUEUED', 'RINGING', 'ACTIVE'];

@Injectable()
export class SessionPrismaRepo implements ISessionRepo {
  constructor(private readonly prisma: PrismaService) {}

  async create(params: ICreateSessionParams): Promise<ISessionRecord> {
    try {
      const row = await this.prisma.session.create({
        data: {
          userId: params.userId,
          mentorProfileId: params.mentorProfileId,
          mentorUserId: params.mentorUserId,
          mode: params.mode,
          status: params.status,
          ratePaisePerMinute: params.ratePaisePerMinute,
          platformFeeBps: params.platformFeeBps,
          livekitRoomName: params.livekitRoomName,
          ringingAt: params.ringingAt,
        },
        include: WITH_MENTOR,
      });
      return toRecord(row);
    } catch (error) {
      // The partial unique index fired. This is the *designed* loser of a race — two tabs, or
      // two instances in M6 promoting from one queue — not a defect, so it becomes the same
      // 409 the pre-flight check would have produced.
      if (isUniqueViolation(error)) {
        throw new ConflictError(
          'SESSION_ALREADY_IN_FLIGHT',
          'There is already a session in progress for this user or mentor.',
        );
      }
      throw error;
    }
  }

  async findById(id: string): Promise<ISessionRecord | null> {
    const row = await this.prisma.session.findUnique({ where: { id }, include: WITH_MENTOR });
    return row ? toRecord(row) : null;
  }

  async findByRoomName(roomName: string): Promise<ISessionRecord | null> {
    const row = await this.prisma.session.findUnique({
      where: { livekitRoomName: roomName },
      include: WITH_MENTOR,
    });
    return row ? toRecord(row) : null;
  }

  async findInflightForUser(userId: string): Promise<ISessionRecord | null> {
    const row = await this.prisma.session.findFirst({
      where: { userId, status: { in: USER_ENGAGED } },
      include: WITH_MENTOR,
    });
    return row ? toRecord(row) : null;
  }

  async findInflightForMentor(mentorProfileId: string): Promise<ISessionRecord | null> {
    const row = await this.prisma.session.findFirst({
      where: { mentorProfileId, status: { in: MENTOR_INFLIGHT } },
      include: WITH_MENTOR,
    });
    return row ? toRecord(row) : null;
  }

  listForUser(userId: string, limit: number, cursor: PageCursor | null): Promise<ISessionRecord[]> {
    return this.listBy({ userId }, limit, cursor);
  }

  listForMentor(
    mentorProfileId: string,
    limit: number,
    cursor: PageCursor | null,
  ): Promise<ISessionRecord[]> {
    return this.listBy({ mentorProfileId }, limit, cursor);
  }

  /**
   * The compare-and-swap every transition goes through.
   *
   * `updateMany` scoped to the expected prior statuses, so a row that already moved on is not
   * touched. `updateManyAndReturn` gives the post-update row in the same statement — without
   * it, a re-read could observe a *later* transition and report it as the one this call made.
   *
   * A terminal move stamps `endedAt` and `endReason` in the same write, because the
   * `Session_terminal_has_reason` CHECK refuses a terminal row without them. That constraint
   * is what makes "a session that ended for no recorded reason" unrepresentable rather than
   * merely unlikely.
   */
  async transition(params: ITransitionParams): Promise<ISessionRecord | null> {
    const at = params.at ?? new Date();
    const terminal = isTerminal(params.to);

    const rows = await this.prisma.session.updateManyAndReturn({
      where: { id: params.sessionId, status: { in: [...params.from] } },
      data: {
        status: params.to,
        ...(params.to === 'RINGING' ? { ringingAt: at } : {}),
        ...(params.to === 'ACTIVE' ? { acceptedAt: at } : {}),
        ...(terminal ? { endedAt: at, endReason: params.endReason } : {}),
      },
    });

    if (rows.length === 0) return null;
    // `updateManyAndReturn` cannot include a relation, so the display name comes from a
    // follow-up read. Safe here in a way a re-read of `status` would not be: a mentor's name
    // is not part of the transition's atomicity.
    return this.findById(params.sessionId);
  }

  /**
   * Stamp-only-if-null. `updateMany` with `billingAnchorAt: null` in the predicate is a
   * compare-and-swap on "nobody has stamped this yet" — a duplicate `participant_joined`
   * webhook, or a rejoin after a dropped connection, finds `count === 0` and leaves the
   * meter's origin exactly where it was.
   */
  async stampBillingAnchor(sessionId: string, at: Date): Promise<boolean> {
    const result = await this.prisma.session.updateMany({
      where: { id: sessionId, billingAnchorAt: null },
      data: { billingAnchorAt: at },
    });
    return result.count > 0;
  }

  async attachRoom(sessionId: string, roomName: string, roomSid: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId },
      data: { livekitRoomName: roomName, livekitRoomSid: roomSid },
    });
  }

  /**
   * `participantJoinCount` counts arrivals including rejoins; `connectedIdentities` is a set.
   * The two answer different questions — "how many times did someone connect" versus "who is
   * here right now" — and conflating them is what makes a rejoin look like a second party.
   */
  async recordParticipantJoined(
    params: IParticipantPresenceParams,
  ): Promise<ISessionRecord | null> {
    const current = await this.prisma.session.findUnique({
      where: { id: params.sessionId },
      select: { connectedIdentities: true },
    });
    if (!current) return null;

    const connected = current.connectedIdentities.includes(params.identity)
      ? current.connectedIdentities
      : [...current.connectedIdentities, params.identity];

    await this.prisma.session.updateMany({
      where: { id: params.sessionId },
      data: {
        participantJoinCount: { increment: 1 },
        connectedIdentities: connected,
      },
    });
    return this.findById(params.sessionId);
  }

  async recordParticipantLeft(params: IParticipantPresenceParams): Promise<ISessionRecord | null> {
    const current = await this.prisma.session.findUnique({
      where: { id: params.sessionId },
      select: { connectedIdentities: true },
    });
    if (!current) return null;

    await this.prisma.session.updateMany({
      where: { id: params.sessionId },
      data: {
        connectedIdentities: current.connectedIdentities.filter(
          (identity) => identity !== params.identity,
        ),
      },
    });
    return this.findById(params.sessionId);
  }

  /**
   * Consent is stamped once and never re-timed. Scoping the update to "still null" means a
   * client that double-submits does not move the recorded moment of consent — which is the
   * one field in this table most likely to be asked about later.
   */
  async recordConsent(
    sessionId: string,
    party: ConsentParty,
    at: Date,
  ): Promise<ISessionRecord | null> {
    const field = party === 'USER' ? 'recordingConsentUserAt' : 'recordingConsentMentorAt';
    await this.prisma.session.updateMany({
      where: { id: sessionId, [field]: null },
      data: { [field]: at },
    });
    return this.findById(sessionId);
  }

  async markSummaryIneligible(sessionId: string, reason: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, summaryIneligibleReason: null },
      data: { summaryIneligibleReason: reason },
    });
  }

  async findRingingBefore(cutoff: Date, limit: number): Promise<ISessionRecord[]> {
    const rows = await this.prisma.session.findMany({
      where: { status: 'RINGING', ringingAt: { lt: cutoff } },
      include: WITH_MENTOR,
      orderBy: { ringingAt: 'asc' },
      take: limit,
    });
    return rows.map(toRecord);
  }

  async findActiveVoiceWithoutAnchorBefore(cutoff: Date, limit: number): Promise<ISessionRecord[]> {
    const rows = await this.prisma.session.findMany({
      // `mode` is a heap filter, not an index column — see the note on the Session indexes.
      // The ACTIVE-with-no-anchor set is tiny, and putting mode into the index would break it
      // for M10's billing sweep, which spans both modes.
      where: { status: 'ACTIVE', mode: 'VOICE', billingAnchorAt: null, acceptedAt: { lt: cutoff } },
      include: WITH_MENTOR,
      orderBy: { acceptedAt: 'asc' },
      take: limit,
    });
    return rows.map(toRecord);
  }

  async findActiveAnchoredBefore(cutoff: Date, limit: number): Promise<ISessionRecord[]> {
    const rows = await this.prisma.session.findMany({
      where: { status: 'ACTIVE', billingAnchorAt: { lt: cutoff } },
      include: WITH_MENTOR,
      orderBy: { billingAnchorAt: 'asc' },
      take: limit,
    });
    return rows.map(toRecord);
  }

  private async listBy(
    scope: { userId: string } | { mentorProfileId: string },
    limit: number,
    cursor: PageCursor | null,
  ): Promise<ISessionRecord[]> {
    const rows = await this.prisma.session.findMany({
      where: {
        ...scope,
        // Newest first, seeking on (createdAt, id) — the same total ordering the mentor
        // catalogue uses, and for the same reason: sessions created in the same millisecond
        // would otherwise be skipped or repeated across a page boundary.
        // `cursor.v` is the ISO string the mapper encoded. Prisma accepts ISO-8601 for a
        // DateTime comparison, so it is passed through rather than re-parsed — one less place
        // for a timezone to be reintroduced. Narrow to string: PageCursor.v is string|number.
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: String(cursor.v) } },
                { AND: [{ createdAt: String(cursor.v) }, { id: { lt: cursor.id } }] },
              ],
            }
          : {}),
      },
      include: WITH_MENTOR,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    return rows.map(toRecord);
  }
}

const toRecord = (row: SessionRow): ISessionRecord => ({
  id: row.id,
  mode: row.mode,
  status: row.status,
  userId: row.userId,
  userDisplayName: row.user.displayName,
  mentorProfileId: row.mentorProfileId,
  mentorUserId: row.mentorUserId,
  mentorDisplayName: row.mentorProfile.displayName,
  ratePaisePerMinute: row.ratePaisePerMinute,
  platformFeeBps: row.platformFeeBps,
  createdAt: row.createdAt,
  ringingAt: row.ringingAt,
  acceptedAt: row.acceptedAt,
  billingAnchorAt: row.billingAnchorAt,
  endedAt: row.endedAt,
  endReason: row.endReason,
  livekitRoomName: row.livekitRoomName,
  livekitRoomSid: row.livekitRoomSid,
  participantJoinCount: row.participantJoinCount,
  connectedIdentities: row.connectedIdentities,
  recordingConsentUserAt: row.recordingConsentUserAt,
  recordingConsentMentorAt: row.recordingConsentMentorAt,
  egressId: row.egressId,
  summaryIneligibleReason: row.summaryIneligibleReason,
  lastMessageAt: row.lastMessageAt,
  messageCount: row.messageCount,
  messagesPurgedAt: row.messagesPurgedAt,
  // A hidden review reads as unrated — it contributes to nothing else either.
  rating: row.review && !row.review.isHidden ? row.review.rating : null,
});
