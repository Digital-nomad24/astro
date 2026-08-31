import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  CallJoinCredentials,
  QueueLeaveReason,
  QueuePositionView,
  SessionEndReason,
  SessionMode,
  SessionView,
} from '@astro/contracts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  isDomainError,
} from '@astro/errors';
import type { ParticipantRole } from '@astro/livekit';

import type { EnvVars } from '../../../../config/env.schema';
import { isUniqueViolation } from '../../../common/db/unique-violation';
import type { AuthenticatedUser } from '../../../identity/contracts/authenticated-user';
import type {
  IMentorProfileRecord,
  IMentorProfileRepo,
} from '../../../mentors/domain/repos/mentor.repos';
import type { ISessionQueue } from '../../domain/ports/session-queue.port';
import { MENTOR_PROFILE_REPO } from '../../../mentors/tokens';
import { PresenceService } from '../../../presence/application/services/presence.service';
import {
  assertTransition,
  isTerminal,
  terminalStatusFor,
} from '../../domain/entities/session.state-machine';
import type { ConsentParty, ISessionRecord, ISessionRepo } from '../../domain/repos/session.repos';
import { LiveKitService } from '../../infra/livekit/livekit.service';
import { SESSION_REPO } from '../../tokens';
import { toSessionView } from '../mappers/session.mapper';

/** What `POST /sessions` returns: a ringing call, or a place in line. Never both. */
export interface StartSessionOutcome {
  readonly session: SessionView;
  readonly credentials: CallJoinCredentials | null;
  /** Non-null exactly when the session came back QUEUED. */
  readonly queue: QueuePositionView | null;
}

/**
 * What a gateway needs in order to fan an event out to the right sockets.
 *
 * A discriminated union rather than four separate channels, because the `/calls` gateway
 * pushes all of it and the `/chat` gateway filters for one case. The queue variants ride here
 * too: a place in line is a fact about a session, and giving the queue its own broadcast
 * channel would mean a second registration path for the same set of sockets.
 */
export type SessionBroadcast =
  | {
      readonly kind: 'incoming' | 'state' | 'connected' | 'ended';
      readonly session: ISessionRecord;
      readonly ringExpiresAtMs?: number;
    }
  | {
      readonly kind: 'queue-position';
      readonly userId: string;
      readonly position: QueuePositionView;
    }
  | {
      readonly kind: 'queue-left';
      readonly userId: string;
      readonly sessionId: string;
      readonly reason: Exclude<QueueLeaveReason, 'PROMOTED'>;
    };

/**
 * Owns every session transition, for both modes.
 *
 * The controllers and the `/calls` gateway are adapters over this — the same transitions have
 * to be reachable from HTTP (the mentor accepts), from the webhook processor (LiveKit says the
 * room finished), from the sweeper (nobody picked up) and from M6's queue dispatcher, so none
 * of the logic may live in any one entry point.
 */
@Injectable()
export class SessionLifecycleService {
  private readonly logger = new Logger(SessionLifecycleService.name);
  private readonly platformFeeBps: number;
  private readonly ringTimeoutSeconds: number;
  private readonly mediaEstablishTimeoutSeconds: number;
  private readonly rejoinGraceSeconds: number;
  private readonly queueMaxDepth: number;

  /**
   * Registered by the gateways at init, so this service never imports a socket type.
   *
   * A list rather than one slot: `/calls` renders the ring and the call state, `/chat` closes
   * the message pane, and from M6 the queue will want the same events. A single slot would
   * silently let whichever gateway initialised last win.
   */
  private readonly broadcasters: ((event: SessionBroadcast) => void)[] = [];

  /**
   * Registered by the queue module at init, if there is one. See `ISessionQueue` for why this
   * is an inversion rather than an injection: the queue depends on this service to promote
   * sessions, so a direct dependency the other way would be a cycle.
   */
  private queue: ISessionQueue | null = null;

  constructor(
    @Inject(SESSION_REPO) private readonly sessions: ISessionRepo,
    @Inject(MENTOR_PROFILE_REPO) private readonly mentors: IMentorProfileRepo,
    private readonly presence: PresenceService,
    private readonly livekit: LiveKitService,
    config: ConfigService<EnvVars, true>,
  ) {
    this.platformFeeBps = config.get('PLATFORM_COMMISSION_BPS', { infer: true });
    this.ringTimeoutSeconds = config.get('RING_TIMEOUT_S', { infer: true });
    this.mediaEstablishTimeoutSeconds = config.get('MEDIA_ESTABLISH_TIMEOUT_S', { infer: true });
    this.rejoinGraceSeconds = config.get('SESSION_REJOIN_GRACE_S', { infer: true });
    this.queueMaxDepth = config.get('QUEUE_MAX_DEPTH', { infer: true });
  }

  addBroadcaster(broadcast: (event: SessionBroadcast) => void): void {
    this.broadcasters.push(broadcast);
  }

  registerQueue(queue: ISessionQueue): void {
    this.queue = queue;
  }

  /** The queue's outbound channel. Shares the gateways' registration rather than adding one. */
  emitQueue(event: Extract<SessionBroadcast, { kind: `queue-${string}` }>): void {
    this.emit(event);
  }

  /** The caller's place in line, or null when they are not waiting. */
  queuePositionFor(sessionId: string): Promise<QueuePositionView | null> {
    return this.queue?.positionOf(sessionId) ?? Promise.resolve(null);
  }

  /**
   * A user's socket came or went.
   *
   * Forwarded to the queue rather than acted on here: a dropped socket is not abandonment,
   * and only the queue knows how long to hold a place before deciding it is.
   */
  async reportUserPresence(userId: string, connected: boolean): Promise<void> {
    if (!this.queue) return;
    try {
      await (connected
        ? this.queue.onUserConnected(userId)
        : this.queue.onUserDisconnected(userId));
    } catch (error) {
      this.logger.warn({
        event: 'queue.presence_report_failed',
        userId,
        connected,
        error: describe(error),
      });
    }
  }

  private requireQueue(): ISessionQueue {
    if (!this.queue) {
      throw new ConflictError('QUEUE_UNAVAILABLE', 'Queueing is not enabled on this deployment.');
    }
    return this.queue;
  }

  // ---------------------------------------------------------------- creation

  /**
   * Starts a session against a mentor.
   *
   * **Ordering is deliberate and must not be "optimised": DB row first, then the LiveKit
   * room.** A `Session` row with no room is recoverable — the sweeper finds it and settles it.
   * A LiveKit room with no `Session` row is an invisible billable resource that nothing in
   * this system will ever look at again.
   *
   * If room creation fails the session is failed immediately rather than left RINGING, because
   * the in-flight partial unique index would otherwise lock the user out of calling anyone
   * until the sweeper caught up.
   */
  async start(
    user: AuthenticatedUser,
    params: { mentorProfileId: string; mode: SessionMode },
  ): Promise<StartSessionOutcome> {
    if (params.mode === 'VIDEO') {
      throw new ValidationError(
        'MODE_NOT_SUPPORTED',
        'Video sessions are not available yet. Use VOICE or TEXT.',
      );
    }
    // Fail fast rather than create a row we cannot furnish with a room.
    if (params.mode === 'VOICE' && !this.livekit.isConfigured) {
      throw new ConflictError(
        'LIVEKIT_NOT_CONFIGURED',
        'Voice calling is unavailable on this deployment.',
      );
    }

    const mentor = await this.mentors.findById(params.mentorProfileId);
    if (!mentor || mentor.approvalStatus !== 'APPROVED') {
      // 404, not 403: an unapproved mentor is not in the catalogue, and confirming that a
      // specific profile id exists but is suspended leaks moderation state to anyone probing.
      throw new NotFoundError('MENTOR_NOT_FOUND', 'That mentor is not available.');
    }
    if (mentor.userId === user.id) {
      throw new ValidationError('SELF_SESSION', 'You cannot start a session with yourself.');
    }

    const presence = await this.presence.snapshotFor([mentor.id]);
    const live = presence[0];
    if (!live) {
      throw new ConflictError('MENTOR_OFFLINE', `${mentor.displayName} is offline right now.`);
    }
    if (!live.acceptingNewCalls) {
      throw new ConflictError(
        'MENTOR_NOT_ACCEPTING',
        `${mentor.displayName} is not taking new sessions right now.`,
      );
    }
    // Availability is decided by the SESSION table, not by presence.
    //
    // `presenceState` only becomes BUSY when a mentor accepts, so a mentor whose phone is
    // ringing still reads as ONLINE — and routing a second caller straight through to them
    // would collide on `session_one_inflight_per_mentor` instead of queueing. Presence is a
    // read-model for browse cards; the authoritative fact is whether an in-flight session
    // exists. `live.state` is still consulted so a BUSY flag set by anything else is honoured.
    const occupied = (await this.sessions.findInflightForMentor(mentor.id)) !== null;

    // Queue when the mentor is occupied — **or when anyone is already waiting**. The second
    // half is what makes the line fair: without it, an arrival at an idle moment would be rung
    // straight through past people who have been waiting ten minutes.
    const queueDepth = this.queue ? await this.queue.depthFor(mentor.id) : 0;
    if (occupied || live.state === 'BUSY' || queueDepth > 0) {
      if (!this.queue) {
        // No queue registered — the M4/M5 behaviour, unchanged.
        throw new ConflictError(
          'MENTOR_BUSY',
          `${mentor.displayName} is on another session. Please try again shortly.`,
        );
      }
      if (queueDepth >= this.queueMaxDepth) {
        // A four-hour wait sold as a queue place is worse for the user than a refusal.
        throw new ConflictError(
          'QUEUE_FULL',
          `${mentor.displayName} has too many people waiting. Please try again later.`,
          { queueDepth },
        );
      }
      return this.enqueue(user, mentor, params.mode);
    }

    const now = new Date();
    let session: ISessionRecord;
    try {
      session = await this.sessions.create({
        userId: user.id,
        mentorProfileId: mentor.id,
        mentorUserId: mentor.userId,
        mode: params.mode,
        status: 'RINGING',
        ratePaisePerMinute: mentor.ratePaisePerMinute,
        platformFeeBps: this.platformFeeBps,
        livekitRoomName: null,
        ringingAt: now,
      });
    } catch (error) {
      // Two callers reached a free mentor in the same instant and the partial unique index
      // picked a winner. The loser is queued rather than refused, so the race is invisible —
      // the check above and this catch are the same decision, one made optimistically.
      //
      // If the conflict was the caller's OWN index instead (they already have a session), the
      // enqueue collides identically and the 409 propagates, which is the right answer.
      if (isDomainError(error) && error.code === 'SESSION_ALREADY_IN_FLIGHT' && this.queue) {
        this.logger.log({ event: 'queue.enqueued_after_race', mentorProfileId: mentor.id });
        return this.enqueue(user, mentor, params.mode);
      }
      throw error;
    }

    if (params.mode === 'VOICE') {
      try {
        const room = await this.livekit.ensureRoom({
          sessionId: session.id,
          // The room must outlive the ring window plus the time media takes to establish, or
          // LiveKit tears it down under a mentor who is still reaching for their headset.
          emptyTimeoutSeconds: this.ringTimeoutSeconds + this.mediaEstablishTimeoutSeconds,
          departureTimeoutSeconds: this.rejoinGraceSeconds,
        });
        await this.sessions.attachRoom(session.id, room.name, room.sid);
        session = (await this.sessions.findById(session.id)) ?? session;
      } catch (error) {
        this.logger.error(
          `LiveKit room creation failed for session ${session.id}: ${describe(error)}`,
        );
        await this.terminate(session.id, 'MEDIA_FAILURE');
        throw new ConflictError(
          'MEDIA_SETUP_FAILED',
          'Could not set up the call. Please try again.',
        );
      }
    }

    this.logTransition(session, 'session.created');
    this.emit({
      kind: 'incoming',
      session,
      ringExpiresAtMs: now.getTime() + this.ringTimeoutSeconds * 1000,
    });

    return {
      session: toSessionView(session),
      credentials: await this.credentialsFor(session, user.id),
      queue: null,
    };
  }

  /**
   * Creates the QUEUED session and puts it in line.
   *
   * **The row exists before the queue entry does.** A queue place pointing at no session is a
   * position nobody can be promoted into — it would look like a working queue right up until
   * the moment it was someone's turn. This ordering is the same argument as "DB row before
   * LiveKit room", applied to the other resource.
   *
   * No LiveKit room is created yet: a queued voice call may wait half an hour, and an empty
   * room held open for that whole time is a billable resource nobody is in. The room is made
   * at promotion, when there is actually someone to ring.
   */
  private async enqueue(
    user: AuthenticatedUser,
    mentor: IMentorProfileRecord,
    mode: SessionMode,
  ): Promise<StartSessionOutcome> {
    const queue = this.requireQueue();

    const session = await this.sessions.create({
      userId: user.id,
      mentorProfileId: mentor.id,
      mentorUserId: mentor.userId,
      mode,
      status: 'QUEUED',
      ratePaisePerMinute: mentor.ratePaisePerMinute,
      platformFeeBps: this.platformFeeBps,
      livekitRoomName: null,
      ringingAt: null,
    });

    try {
      const position = await queue.enqueue({
        sessionId: session.id,
        mentorProfileId: mentor.id,
        userId: user.id,
        mode,
      });

      this.logTransition(session, 'queue.enqueued');
      this.emit({ kind: 'state', session });
      return { session: toSessionView(session), credentials: null, queue: position };
    } catch (error) {
      // The session row would otherwise sit QUEUED forever holding the user's engaged slot,
      // locking them out of booking anyone at all.
      this.logger.error(`Enqueue failed for session ${session.id}: ${describe(error)}`);
      await this.terminate(session.id, 'QUEUE_EXPIRED');
      throw error;
    }
  }

  /**
   * QUEUED → RINGING. Called only by the queue's dispatcher.
   *
   * Returns a discriminated outcome rather than throwing, because every failure here is a
   * routine race the caller has to act on differently: `MENTOR_BUSY` means put the user back
   * at their original score, `GONE` means they left while being promoted.
   */
  async promoteToRinging(
    sessionId: string,
  ): Promise<{ outcome: 'PROMOTED' | 'MENTOR_BUSY' | 'GONE' }> {
    const session = await this.sessions.findById(sessionId);
    if (!session || session.status !== 'QUEUED') return { outcome: 'GONE' };

    const now = new Date();
    let ringing: ISessionRecord | null;
    try {
      ringing = await this.sessions.transition({
        sessionId,
        from: ['QUEUED'],
        to: 'RINGING',
        at: now,
      });
    } catch (error) {
      // `session_one_inflight_per_mentor` fired on the UPDATE: another instance promoted a
      // different waiting user microseconds earlier. **This is the real mutual exclusion** —
      // the Lua dispatch lock only makes this rare. The caller reinstates at the original
      // score, so losing costs nothing but a moment.
      if (isUniqueViolation(error)) return { outcome: 'MENTOR_BUSY' };
      throw error;
    }
    if (!ringing) return { outcome: 'GONE' };

    if (ringing.mode === 'VOICE') {
      try {
        const room = await this.livekit.ensureRoom({
          sessionId,
          emptyTimeoutSeconds: this.ringTimeoutSeconds + this.mediaEstablishTimeoutSeconds,
          departureTimeoutSeconds: this.rejoinGraceSeconds,
        });
        await this.sessions.attachRoom(sessionId, room.name, room.sid);
      } catch (error) {
        this.logger.error(`Room creation failed promoting ${sessionId}: ${describe(error)}`);
        await this.terminate(sessionId, 'MEDIA_FAILURE');
        // Reported as GONE, not MENTOR_BUSY: this user's session is dead, so reinstating them
        // would put a terminated session back in the queue. The mentor is still free, and the
        // dispatcher moves on to the next person.
        return { outcome: 'GONE' };
      }
    }

    const promoted = (await this.sessions.findById(sessionId)) ?? ringing;
    this.logTransition(promoted, 'queue.promoted');
    this.emit({
      kind: 'incoming',
      session: promoted,
      ringExpiresAtMs: now.getTime() + this.ringTimeoutSeconds * 1000,
    });
    // The user's own client needs the QUEUED → RINGING transition too — from their side the
    // wait just turned into a call.
    this.emit({ kind: 'state', session: promoted });

    return { outcome: 'PROMOTED' };
  }

  // ------------------------------------------------------------- transitions

  async accept(sessionId: string, actor: AuthenticatedUser): Promise<StartSessionOutcome> {
    const session = await this.requireParticipant(sessionId, actor);
    if (session.mentorUserId !== actor.id) {
      throw new ForbiddenError('NOT_THE_MENTOR', 'Only the mentor can accept a session.');
    }
    assertTransition(session.status, 'ACTIVE');

    const accepted = await this.sessions.transition({
      sessionId,
      from: ['RINGING'],
      to: 'ACTIVE',
    });
    if (!accepted) {
      // The overwhelmingly common cause is the ring-timeout sweeper getting there first at
      // second 30. The mentor sees a clear "this call already ended", not a silent no-op.
      throw new ConflictError(
        'SESSION_NO_LONGER_RINGING',
        'That session is no longer ringing — it may have timed out or been cancelled.',
      );
    }

    // BUSY only once the mentor has actually committed. Flipping at RINGING would make a
    // mentor unbookable during every call they decline.
    await this.setBusySafely(accepted.mentorProfileId, true);

    this.logTransition(accepted, 'session.accepted');
    this.emit({ kind: 'state', session: accepted });

    return {
      session: toSessionView(accepted),
      credentials: await this.credentialsFor(accepted, actor.id),
      // An accepted session has left the queue by definition — it is the call now.
      queue: null,
    };
  }

  async decline(sessionId: string, actor: AuthenticatedUser): Promise<SessionView> {
    const session = await this.requireParticipant(sessionId, actor);
    if (session.mentorUserId !== actor.id) {
      throw new ForbiddenError('NOT_THE_MENTOR', 'Only the mentor can decline a session.');
    }
    return this.endWith(session, 'DECLINED', ['RINGING']);
  }

  async cancel(sessionId: string, actor: AuthenticatedUser): Promise<SessionView> {
    const session = await this.requireParticipant(sessionId, actor);
    if (session.userId !== actor.id) {
      throw new ForbiddenError('NOT_THE_CALLER', 'Only the caller can cancel a ringing session.');
    }
    return this.endWith(session, 'CANCELLED_BY_USER', ['QUEUED', 'RINGING']);
  }

  /** Either party hangs up an ACTIVE session. The reason records which one. */
  async end(sessionId: string, actor: AuthenticatedUser): Promise<SessionView> {
    const session = await this.requireParticipant(sessionId, actor);
    const reason: SessionEndReason =
      session.mentorUserId === actor.id ? 'COMPLETED_BY_MENTOR' : 'COMPLETED_BY_USER';
    return this.endWith(session, reason, ['QUEUED', 'RINGING', 'ACTIVE']);
  }

  /**
   * Server-initiated termination: ring timeout, max duration, media failure, the M10 balance
   * cutoff. Returns null when the session had already reached a terminal state — every one of
   * these paths races the participants, and losing that race is the normal case.
   */
  async terminate(sessionId: string, reason: SessionEndReason): Promise<ISessionRecord | null> {
    const session = await this.sessions.findById(sessionId);
    if (!session || isTerminal(session.status)) return null;
    return this.settle(session, reason, ['QUEUED', 'RINGING', 'ACTIVE']);
  }

  // ------------------------------------------------------------ participants

  /**
   * A party arrived in the room. Called from the verified `participant_joined` webhook.
   *
   * The billing anchor is stamped when the SECOND party is present — not on the first join.
   * A mentor must not bill for the user sitting alone in a room waiting for them to pick up.
   * Because the stamp is conditional on "still null", a duplicate delivery of the same event
   * bumps the join count and leaves the meter's origin exactly where it was.
   */
  async onParticipantJoined(sessionId: string, identity: string): Promise<void> {
    const session = await this.sessions.recordParticipantJoined({ sessionId, identity });
    if (!session) return;

    if (isTerminal(session.status)) {
      // A join for a session we already closed. Nothing to update, but worth seeing: it means
      // a client is holding a token for a call that is over.
      this.logger.warn({
        event: 'livekit.webhook.late_event',
        sessionId,
        identity,
        status: session.status,
      });
      return;
    }

    if (session.connectedIdentities.length < 2) return;

    const stamped = await this.sessions.stampBillingAnchor(sessionId, new Date());
    if (!stamped) return; // A rejoin, not a start. The call was already under way.

    const anchored = (await this.sessions.findById(sessionId)) ?? session;
    this.logTransition(anchored, 'session.anchored');
    this.emit({ kind: 'connected', session: anchored });
  }

  /**
   * The text equivalent of `onParticipantJoined`: the conversation has actually begun.
   *
   * The chat repo stamps the anchor inside the same transaction as the first message — it has
   * to, or a crash between the two would meter a conversation from the wrong moment. This only
   * announces what already happened, so that "the session is connected" means the same thing
   * to both modes' clients even though the two anchors are derived completely differently.
   */
  async announceTextAnchor(sessionId: string): Promise<void> {
    const session = await this.sessions.findById(sessionId);
    if (!session || !session.billingAnchorAt) return;

    this.logTransition(session, 'session.anchored');
    this.emit({ kind: 'connected', session });
  }

  /**
   * A party left. Deliberately does NOT end the session.
   *
   * LiveKit keeps the room alive for `departureTimeout` precisely so a dropped connection can
   * come back, and a phone switching from wifi to mobile data produces exactly this event.
   * `room_finished` is what ends a call; this only updates who is currently present.
   */
  async onParticipantLeft(sessionId: string, identity: string): Promise<void> {
    await this.sessions.recordParticipantLeft({ sessionId, identity });
  }

  /** LiveKit tore the room down. This is the authoritative end of a voice session. */
  async onRoomFinished(sessionId: string, endedAtMs: number): Promise<void> {
    const session = await this.sessions.findById(sessionId);
    if (!session) return;
    if (isTerminal(session.status)) return; // We ended it ourselves; the webhook confirms it.

    // The reason is inferred from how far the session got: a room that finished before both
    // parties ever connected did not complete, it failed to establish.
    const reason: SessionEndReason = session.billingAnchorAt
      ? 'COMPLETED_BY_USER'
      : 'MEDIA_FAILURE';

    await this.settle(session, reason, ['QUEUED', 'RINGING', 'ACTIVE'], new Date(endedAtMs));
  }

  // ----------------------------------------------------------------- reads

  async credentialsFor(
    session: ISessionRecord,
    userId: string,
  ): Promise<CallJoinCredentials | null> {
    // Text sessions have no media transport, and a terminal one has nothing to join.
    if (session.mode !== 'VOICE' || isTerminal(session.status)) return null;
    if (!this.livekit.isConfigured) return null;

    const role: ParticipantRole = session.mentorUserId === userId ? 'mentor' : 'user';
    const minted = await this.livekit.mintToken({
      sessionId: session.id,
      role,
      userId,
      displayName: role === 'mentor' ? session.mentorDisplayName : 'Guest',
    });

    return {
      sessionId: session.id,
      url: this.livekit.clientUrl,
      token: minted.token,
      identity: minted.identity,
      roomName: minted.roomName,
      expiresAtMs: minted.expiresAtMs,
    };
  }

  async findInflightFor(user: AuthenticatedUser): Promise<ISessionRecord | null> {
    const asCaller = await this.sessions.findInflightForUser(user.id);
    if (asCaller) return asCaller;
    if (user.role !== 'MENTOR' && user.role !== 'ADMIN') return null;

    const profile = await this.mentors.findByUserId(user.id);
    return profile ? this.sessions.findInflightForMentor(profile.id) : null;
  }

  async requireParticipant(sessionId: string, actor: AuthenticatedUser): Promise<ISessionRecord> {
    const session = await this.sessions.findById(sessionId);
    // A non-participant gets 404, not 403. Distinguishing "does not exist" from "not yours"
    // would let anyone enumerate which session ids are real.
    if (!session) throw new NotFoundError('SESSION_NOT_FOUND', 'Session not found.');
    if (session.userId !== actor.id && session.mentorUserId !== actor.id) {
      if (actor.role !== 'ADMIN') {
        throw new NotFoundError('SESSION_NOT_FOUND', 'Session not found.');
      }
    }
    return session;
  }

  async recordConsent(sessionId: string, actor: AuthenticatedUser): Promise<SessionView> {
    const session = await this.requireParticipant(sessionId, actor);
    if (isTerminal(session.status)) {
      throw new ConflictError(
        'SESSION_ENDED',
        'That session has ended; consent can no longer be recorded for it.',
      );
    }

    const party: ConsentParty = session.mentorUserId === actor.id ? 'MENTOR' : 'USER';
    const updated = (await this.sessions.recordConsent(sessionId, party, new Date())) ?? session;

    this.logger.log({ event: 'session.consent_recorded', sessionId, party });
    this.emit({ kind: 'state', session: updated });
    return toSessionView(updated);
  }

  // --------------------------------------------------------------- internals

  private async endWith(
    session: ISessionRecord,
    reason: SessionEndReason,
    from: readonly ISessionRecord['status'][],
  ): Promise<SessionView> {
    const settled = await this.settle(session, reason, from);
    if (!settled) {
      throw new ConflictError('SESSION_ALREADY_ENDED', 'That session has already ended.', {
        status: session.status,
      });
    }
    return toSessionView(settled);
  }

  /**
   * The one path every ending goes through.
   *
   * Order matters: the database row is settled **first**, then the room is closed. The row is
   * what frees the caller's in-flight slot, and a LiveKit outage must never be able to strand
   * a user unable to start another call. Closing the room afterwards is best-effort — it will
   * expire on its own `emptyTimeout` regardless.
   */
  private async settle(
    session: ISessionRecord,
    reason: SessionEndReason,
    from: readonly ISessionRecord['status'][],
    at?: Date,
  ): Promise<ISessionRecord | null> {
    const to = terminalStatusFor(reason, session.status);

    const settled = await this.sessions.transition({
      sessionId: session.id,
      from,
      to,
      endReason: reason,
      at,
    });
    if (!settled) return null;

    if (settled.livekitRoomName) {
      await this.livekit.closeRoom(settled.livekitRoomName);
    }
    // Only if the session had actually made the mentor busy. A declined call never did.
    if (session.status === 'ACTIVE') {
      await this.setBusySafely(settled.mentorProfileId, false);
      // Feeds the queue ETA. Best-effort: a wrong estimate is a cosmetic problem, and failing
      // the end of a session over one would not be.
      await this.recordMentorHistory(settled);
    }

    // A session that ended while still QUEUED has to leave the line as well — otherwise the
    // sorted set keeps a member pointing at a terminated session, and the dispatcher would
    // promote it into nothing.
    if (session.status === 'QUEUED' && this.queue) {
      await this.releaseFromQueueSafely(settled.id, reason);
    }

    this.logTransition(settled, 'session.ended');
    this.emit({ kind: 'ended', session: settled });

    // The mentor is free again — offer their next waiting user. Deliberately after the
    // broadcast and deliberately unable to fail this method: the dispatcher racing its own
    // reconciler is fine, a session that could not end is not.
    if (session.status === 'ACTIVE' || session.status === 'RINGING') {
      await this.dispatchNextSafely(settled.mentorProfileId);
    }

    return settled;
  }

  private async releaseFromQueueSafely(sessionId: string, reason: SessionEndReason): Promise<void> {
    try {
      await this.queue?.release(
        sessionId,
        reason === 'MENTOR_OFFLINE' ? 'MENTOR_OFFLINE' : 'CANCELLED_BY_USER',
      );
    } catch (error) {
      // The reconciler drops members whose entry is no longer WAITING, so a failure here
      // self-heals within a minute.
      this.logger.warn({ event: 'queue.release_failed', sessionId, error: describe(error) });
    }
  }

  private async dispatchNextSafely(mentorProfileId: string): Promise<void> {
    if (!this.queue) return;
    try {
      await this.queue.dispatchNext(mentorProfileId);
    } catch (error) {
      this.logger.warn({
        event: 'queue.dispatch_failed',
        mentorProfileId,
        error: describe(error),
      });
    }
  }

  /**
   * Accumulates the mentor's session history, which is what turns the queue ETA from a
   * constant into an estimate. Only counts sessions that actually connected — a declined call
   * has no duration to average.
   */
  private async recordMentorHistory(session: ISessionRecord): Promise<void> {
    if (!session.billingAnchorAt || !session.endedAt) return;
    const seconds = Math.max(
      0,
      Math.floor((session.endedAt.getTime() - session.billingAnchorAt.getTime()) / 1000),
    );

    try {
      await this.mentors.recordCompletedSession(session.mentorProfileId, seconds);
    } catch (error) {
      this.logger.warn({
        event: 'mentor.history_update_failed',
        mentorProfileId: session.mentorProfileId,
        error: describe(error),
      });
    }
  }

  /**
   * Presence is a derived view; failing to update it must never fail a session transition.
   * The worst case is a browse card that says ONLINE for one heartbeat while the mentor is on
   * a call, and the pre-flight check in `start` still rejects the booking.
   */
  private async setBusySafely(mentorProfileId: string, busy: boolean): Promise<void> {
    try {
      await this.presence.setBusy(mentorProfileId, busy);
    } catch (error) {
      this.logger.warn({
        event: 'session.presence_sync_failed',
        mentorProfileId,
        busy,
        error: describe(error),
      });
    }
  }

  /**
   * One misbehaving gateway must not stop the others from being told, and must not fail the
   * transition that produced the event — the row is already committed by this point.
   */
  private emit(event: SessionBroadcast): void {
    for (const broadcast of this.broadcasters) {
      try {
        broadcast(event);
      } catch (error) {
        this.logger.warn({
          event: 'session.broadcast_failed',
          sessionId: sessionIdOf(event),
          kind: event.kind,
          error: describe(error),
        });
      }
    }
  }

  private logTransition(session: ISessionRecord, event: string): void {
    this.logger.log({
      event,
      sessionId: session.id,
      mode: session.mode,
      status: session.status,
      mentorProfileId: session.mentorProfileId,
      userId: session.userId,
      endReason: session.endReason,
    });
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Every broadcast variant is about exactly one session; they just carry it differently. */
const sessionIdOf = (event: SessionBroadcast): string => {
  if ('session' in event) return event.session.id;
  return event.kind === 'queue-position' ? event.position.sessionId : event.sessionId;
};
