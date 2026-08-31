import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SessionView } from '@astro/contracts';
import { ForbiddenError, NotFoundError } from '@astro/errors';

import type { EnvVars } from '../../../../config/env.schema';
import { decodeCursor, toPage, type Page } from '../../../common/pagination/cursor';
import type { AuthenticatedUser } from '../../../identity/contracts/authenticated-user';
import type { IMentorProfileRepo } from '../../../mentors/domain/repos/mentor.repos';
import { MENTOR_PROFILE_REPO } from '../../../mentors/tokens';
import type { ISessionRepo } from '../../domain/repos/session.repos';
import { SESSION_REPO } from '../../tokens';
import { toSessionView } from '../mappers/session.mapper';
import {
  SessionLifecycleService,
  type StartSessionOutcome,
} from '../services/session-lifecycle.service';

export interface StartSessionInput {
  readonly mentorProfileId: string;
  readonly mode: 'VOICE' | 'TEXT';
}

/**
 * One response shape for every route that hands back a session plus how to join it.
 *
 * `queue` is non-null exactly when the session came back QUEUED, so a client branches on one
 * field rather than inferring the mode of the response from which other fields are null.
 */
export type StartSessionResult = StartSessionOutcome;

@Injectable()
export class StartSessionUseCase {
  constructor(private readonly lifecycle: SessionLifecycleService) {}

  execute(user: AuthenticatedUser, input: StartSessionInput): Promise<StartSessionResult> {
    return this.lifecycle.start(user, input);
  }
}

@Injectable()
export class AcceptSessionUseCase {
  constructor(private readonly lifecycle: SessionLifecycleService) {}

  execute(user: AuthenticatedUser, sessionId: string): Promise<StartSessionResult> {
    return this.lifecycle.accept(sessionId, user);
  }
}

@Injectable()
export class DeclineSessionUseCase {
  constructor(private readonly lifecycle: SessionLifecycleService) {}

  execute(user: AuthenticatedUser, sessionId: string): Promise<SessionView> {
    return this.lifecycle.decline(sessionId, user);
  }
}

@Injectable()
export class CancelSessionUseCase {
  constructor(private readonly lifecycle: SessionLifecycleService) {}

  execute(user: AuthenticatedUser, sessionId: string): Promise<SessionView> {
    return this.lifecycle.cancel(sessionId, user);
  }
}

@Injectable()
export class EndSessionUseCase {
  constructor(private readonly lifecycle: SessionLifecycleService) {}

  execute(user: AuthenticatedUser, sessionId: string): Promise<SessionView> {
    return this.lifecycle.end(sessionId, user);
  }
}

/**
 * Per-session recording consent.
 *
 * Deliberately its own route rather than a flag on `POST /sessions`: consent has to be
 * recordable *after* a call is under way (the mentor's blanket consent is taken at onboarding,
 * the user's is shown at session start), and bundling it into creation would mean a user who
 * had not yet answered the prompt could not start a call at all.
 */
@Injectable()
export class RecordConsentUseCase {
  constructor(private readonly lifecycle: SessionLifecycleService) {}

  execute(user: AuthenticatedUser, sessionId: string): Promise<SessionView> {
    return this.lifecycle.recordConsent(sessionId, user);
  }
}

/**
 * Re-issues join credentials for a session already in progress.
 *
 * This is the rejoin path: a refreshed tab, a laptop waking up, a phone changing networks. The
 * session is untouched — only a fresh token is minted — which is why it is a POST that reads
 * rather than a transition.
 */
@Injectable()
export class IssueSessionCredentialsUseCase {
  constructor(private readonly lifecycle: SessionLifecycleService) {}

  async execute(user: AuthenticatedUser, sessionId: string): Promise<StartSessionResult> {
    const session = await this.lifecycle.requireParticipant(sessionId, user);
    if (session.userId !== user.id && session.mentorUserId !== user.id) {
      // An ADMIN passes `requireParticipant` for read access, but there is no identity to mint
      // a token for — admins observe sessions, they do not join them.
      throw new ForbiddenError(
        'NOT_A_PARTICIPANT',
        'Only the two participants can join this session.',
      );
    }
    return {
      session: toSessionView(session),
      credentials: await this.lifecycle.credentialsFor(session, user.id),
      // Still meaningful for a reconnect that lands while the caller is waiting in line.
      queue: await this.lifecycle.queuePositionFor(session.id),
    };
  }
}

@Injectable()
export class GetSessionUseCase {
  constructor(private readonly lifecycle: SessionLifecycleService) {}

  async execute(user: AuthenticatedUser, sessionId: string): Promise<SessionView> {
    return toSessionView(await this.lifecycle.requireParticipant(sessionId, user));
  }
}

/** The caller's current in-flight session, if any. Drives the "you are in a call" banner. */
@Injectable()
export class GetActiveSessionUseCase {
  constructor(private readonly lifecycle: SessionLifecycleService) {}

  async execute(user: AuthenticatedUser): Promise<SessionView | null> {
    const session = await this.lifecycle.findInflightFor(user);
    return session ? toSessionView(session) : null;
  }
}

export interface ListSessionsInput {
  readonly as?: 'user' | 'mentor';
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * Session history, from either side.
 *
 * `as=mentor` reads the mentor's own sessions, which is a different index and a different
 * authorisation question from `as=user` — hence one parameter rather than two routes that
 * would share almost all of their body.
 */
@Injectable()
export class ListSessionsUseCase {
  private readonly defaultLimit: number;

  constructor(
    @Inject(SESSION_REPO) private readonly sessions: ISessionRepo,
    @Inject(MENTOR_PROFILE_REPO) private readonly mentors: IMentorProfileRepo,
    config: ConfigService<EnvVars, true>,
  ) {
    this.defaultLimit = config.get('CHAT_HISTORY_PAGE_SIZE', { infer: true });
  }

  async execute(user: AuthenticatedUser, input: ListSessionsInput): Promise<Page<SessionView>> {
    const limit = Math.min(Math.max(input.limit ?? this.defaultLimit, 1), 100);
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;

    const rows =
      input.as === 'mentor'
        ? await this.sessions.listForMentor(await this.mentorProfileIdOf(user), limit, cursor)
        : await this.sessions.listForUser(user.id, limit, cursor);

    // One `now` for the whole page, so a live session's `billedSeconds` cannot differ between
    // two rows of the same response purely because mapping took a millisecond.
    const now = new Date();
    return toPage(
      rows.map((row) => toSessionView(row, now)),
      limit,
      (view) => ({ v: view.createdAt, id: view.id }),
    );
  }

  private async mentorProfileIdOf(user: AuthenticatedUser): Promise<string> {
    const profile = await this.mentors.findByUserId(user.id);
    if (!profile) {
      throw new NotFoundError('MENTOR_PROFILE_NOT_FOUND', 'You do not have a mentor profile.');
    }
    return profile.id;
  }
}
