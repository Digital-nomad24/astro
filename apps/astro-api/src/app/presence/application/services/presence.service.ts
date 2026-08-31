import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ForbiddenError, NotFoundError } from '@astro/errors';
import type { MentorPresenceSnapshot, PresenceState } from '@astro/contracts';

import type { EnvVars } from '../../../../config/env.schema';
import type {
  IMentorProfileRecord,
  IMentorProfileRepo,
} from '../../../mentors/domain/repos/mentor.repos';
import { MENTOR_PROFILE_REPO } from '../../../mentors/tokens';
import type { IPresenceRecord, IPresenceRepo } from '../../domain/repos/presence.repo.interface';
import { PRESENCE_REPO } from '../../tokens';

/**
 * Owns every presence transition and the fan-out that follows it.
 *
 * The gateway is a thin socket adapter over this: the transitions must also be callable from
 * HTTP (admin suspension), from the sessions module (BUSY on call start, M4), and from the
 * sweeper — so none of the logic lives in the gateway.
 */
@Injectable()
export class PresenceService {
  private readonly logger = new Logger(PresenceService.name);
  private readonly ttlSeconds: number;

  /** Set by the gateway at init. Kept as a callback so this service never imports the gateway. */
  private broadcaster: ((snapshot: MentorPresenceSnapshot) => void) | null = null;

  constructor(
    @Inject(PRESENCE_REPO) private readonly presence: IPresenceRepo,
    @Inject(MENTOR_PROFILE_REPO) private readonly mentors: IMentorProfileRepo,
    config: ConfigService<EnvVars, true>,
  ) {
    this.ttlSeconds = config.get('PRESENCE_TTL_S', { infer: true });
  }

  get heartbeatTtlSeconds(): number {
    return this.ttlSeconds;
  }

  registerBroadcaster(broadcast: (snapshot: MentorPresenceSnapshot) => void): void {
    this.broadcaster = broadcast;
  }

  /**
   * A mentor announces availability.
   *
   * Only an APPROVED mentor may go online. Without this check a suspended mentor could still
   * appear in every subscriber's live feed — the catalogue query filters on approval, but a
   * pushed `presence:changed` bypasses that query entirely.
   */
  async goOnline(userId: string, acceptingNewCalls: boolean): Promise<MentorPresenceSnapshot> {
    const mentor = await this.requireMentor(userId);
    if (mentor.approvalStatus !== 'APPROVED') {
      throw new ForbiddenError(
        'MENTOR_NOT_APPROVED',
        'Your mentor profile is not approved, so you cannot go online yet.',
      );
    }

    // A mentor already in a session stays BUSY: going online must not clear a call in
    // progress. (Nothing sets BUSY until M4, so today this always resolves to ONLINE.)
    const current = await this.presence.get(mentor.id);
    const state: Exclude<PresenceState, 'OFFLINE'> = current?.state === 'BUSY' ? 'BUSY' : 'ONLINE';

    return this.publish(mentor, state, acceptingNewCalls);
  }

  async goOffline(userId: string): Promise<void> {
    const mentor = await this.requireMentor(userId);
    await this.markOffline(mentor.id, mentor.categorySlug, mentor.ratePaisePerMinute);
  }

  async setAccepting(userId: string, accepting: boolean): Promise<MentorPresenceSnapshot> {
    const mentor = await this.requireMentor(userId);
    const current = await this.presence.get(mentor.id);
    if (!current) {
      throw new NotFoundError('NOT_ONLINE', 'Go online before changing your availability.');
    }
    return this.publish(mentor, current.state, accepting, current.queueDepth);
  }

  /**
   * Refresh the TTL. Returns false when the record had already lapsed — the caller
   * re-announces rather than heartbeating a record no subscriber can see.
   */
  async heartbeat(userId: string): Promise<boolean> {
    const mentor = await this.requireMentor(userId);
    return this.presence.touch(mentor.id, this.ttlSeconds);
  }

  /** Used by the sweeper and by admin suspension. Safe to call when already offline. */
  async markOffline(
    mentorProfileId: string,
    categorySlug: string,
    ratePaisePerMinute: number,
  ): Promise<void> {
    await this.presence.clear(mentorProfileId);
    await this.mentors
      .updatePresence({ mentorProfileId, presenceState: 'OFFLINE' })
      .catch((err: unknown) => this.logReadModelFailure(mentorProfileId, err));

    this.emit({
      mentorProfileId,
      categorySlug,
      state: 'OFFLINE',
      acceptingNewCalls: false,
      queueDepth: 0,
      ratePaisePerMinute,
      updatedAtMs: Date.now(),
    });
  }

  /**
   * Flips a mentor between ONLINE and BUSY as a session starts and ends.
   *
   * Called by the sessions module (M4) through this service, never by writing Redis directly —
   * BUSY is a presence concept, and the broadcast that has to accompany it lives here.
   *
   * **A mentor with no live presence record is left alone.** That combination is real: a
   * mentor can be mid-call while their heartbeat lapses, and re-creating a record here would
   * resurrect them as ONLINE on every browse page the moment the call ended, without them
   * ever having reconnected. Presence is owned by the mentor's own socket; this only
   * annotates a presence that already exists.
   */
  async setBusy(mentorProfileId: string, busy: boolean): Promise<void> {
    const current = await this.presence.get(mentorProfileId);
    if (!current) return;

    const state: Exclude<PresenceState, 'OFFLINE'> = busy ? 'BUSY' : 'ONLINE';
    if (current.state === state) return;

    const record: IPresenceRecord = { ...current, state, updatedAtMs: Date.now() };
    await this.presence.set(record, this.ttlSeconds);
    await this.mentors
      .updatePresence({ mentorProfileId, presenceState: state })
      .catch((err: unknown) => this.logReadModelFailure(mentorProfileId, err));

    this.emit(record);
  }

  async snapshotFor(mentorProfileIds: readonly string[]): Promise<MentorPresenceSnapshot[]> {
    const records = await this.presence.getMany(mentorProfileIds);
    return records.map((record) => ({ ...record }));
  }

  private async publish(
    mentor: IMentorProfileRecord,
    state: Exclude<PresenceState, 'OFFLINE'>,
    acceptingNewCalls: boolean,
    queueDepth = 0,
  ): Promise<MentorPresenceSnapshot> {
    // Typed as the stored record first, so `state` stays narrowed to the online states —
    // there is no OFFLINE record by construction, since absence of the key IS offline.
    // A snapshot is the same shape widened, so the assignment below needs no cast.
    const record: IPresenceRecord = {
      mentorProfileId: mentor.id,
      categorySlug: mentor.categorySlug,
      state,
      acceptingNewCalls,
      queueDepth,
      ratePaisePerMinute: mentor.ratePaisePerMinute,
      updatedAtMs: Date.now(),
    };
    const snapshot: MentorPresenceSnapshot = record;

    // Redis first: it is the truth other instances read. The read model and the broadcast are
    // both derived, and both are recoverable if they fail.
    await this.presence.set(record, this.ttlSeconds);
    await this.mentors
      .updatePresence({
        mentorProfileId: mentor.id,
        presenceState: state,
        acceptingNewCalls,
        queueDepth,
      })
      .catch((err: unknown) => this.logReadModelFailure(mentor.id, err));

    this.emit(snapshot);
    return snapshot;
  }

  private emit(snapshot: MentorPresenceSnapshot): void {
    this.logger.log({
      event: 'presence.changed',
      mentorProfileId: snapshot.mentorProfileId,
      state: snapshot.state,
      acceptingNewCalls: snapshot.acceptingNewCalls,
    });
    this.broadcaster?.(snapshot);
  }

  private async requireMentor(userId: string): Promise<IMentorProfileRecord> {
    const mentor = await this.mentors.findByUserId(userId);
    if (!mentor) {
      throw new NotFoundError('MENTOR_PROFILE_NOT_FOUND', 'You do not have a mentor profile.');
    }
    return mentor;
  }

  private logReadModelFailure(mentorProfileId: string, err: unknown): void {
    // Non-fatal by design: the browse card is briefly stale, nothing live is wrong, and the
    // next transition or sweeper pass corrects it.
    this.logger.warn({
      event: 'presence.read_model_sync_failed',
      mentorProfileId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
