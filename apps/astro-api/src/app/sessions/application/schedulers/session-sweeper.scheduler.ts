import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { SessionEndReason } from '@astro/contracts';

import type { EnvVars } from '../../../../config/env.schema';
import { LeaderLockService } from '../../../infra/redis/leader-lock.service';
import type { ISessionRecord, ISessionRepo } from '../../domain/repos/session.repos';
import { SESSION_REPO } from '../../tokens';
import { SessionLifecycleService } from '../services/session-lifecycle.service';

/** How many sessions one tick will settle. Bounds the blast radius of a stuck sweep. */
const BATCH_SIZE = 100;

/**
 * Closes sessions that no participant is going to close.
 *
 * Three distinct failure shapes, all ending the same way but for different reasons — and the
 * reasons matter, because they are what tells "nobody picked up" apart from "the call broke":
 *
 * - **Ring timeout** — RINGING past `RING_TIMEOUT_S`. Nobody answered.
 * - **Media never established (VOICE only)** — ACTIVE but still un-anchored past
 *   `MEDIA_ESTABLISH_TIMEOUT_S`. The mentor accepted, but the two sides never both connected.
 *   Without this, such a session sits ACTIVE forever holding both parties' in-flight slots.
 *   Text is excluded: an un-anchored text session is one where nobody has typed yet, which is
 *   normal. `ChatIdleScheduler` is its backstop.
 * - **Max duration** — ACTIVE past `SESSION_MAX_DURATION_S`. Until M10 lands the balance
 *   cutoff, **this is the only stop on a running call**, which is why the cap sits under Cloud
 *   Run's 3600s socket ceiling rather than at some round number.
 *
 * Every one of these races the participants. `terminate` is a conditional update, so losing
 * that race is a no-op rather than a double-ending.
 */
@Injectable()
export class SessionSweeperScheduler {
  private readonly logger = new Logger(SessionSweeperScheduler.name);
  private readonly ringTimeoutSeconds: number;
  private readonly mediaEstablishTimeoutSeconds: number;
  private readonly maxDurationSeconds: number;

  constructor(
    @Inject(SESSION_REPO) private readonly sessions: ISessionRepo,
    private readonly lifecycle: SessionLifecycleService,
    private readonly leaderLock: LeaderLockService,
    config: ConfigService<EnvVars, true>,
  ) {
    this.ringTimeoutSeconds = config.get('RING_TIMEOUT_S', { infer: true });
    this.mediaEstablishTimeoutSeconds = config.get('MEDIA_ESTABLISH_TIMEOUT_S', { infer: true });
    this.maxDurationSeconds = config.get('SESSION_MAX_DURATION_S', { infer: true });
  }

  /**
   * Every 10 seconds, because a 30-second ring timeout swept once a minute would let a call
   * ring for 90. Nothing may escape this method: an unhandled rejection out of a `@Cron` takes
   * the Node process down by default, and this one runs on instances serving live calls.
   */
  @Cron(CronExpression.EVERY_10_SECONDS)
  async sweep(): Promise<void> {
    try {
      await this.leaderLock.withLock('sessions:sweep', () => this.run());
    } catch (error) {
      this.logger.warn(`Session sweep tick failed: ${describe(error)}`);
    }
  }

  private async run(): Promise<void> {
    const now = Date.now();

    await this.settleAll(
      await this.sessions.findRingingBefore(
        new Date(now - this.ringTimeoutSeconds * 1000),
        BATCH_SIZE,
      ),
      'RING_TIMEOUT',
    );

    // VOICE only. A text session is un-anchored until its first message, and a pause before
    // someone types is not a media failure — that path is the chat idle sweeper, on a scale of
    // minutes and measured from the last message rather than from accept.
    await this.settleAll(
      await this.sessions.findActiveVoiceWithoutAnchorBefore(
        new Date(now - this.mediaEstablishTimeoutSeconds * 1000),
        BATCH_SIZE,
      ),
      'MEDIA_FAILURE',
    );

    await this.settleAll(
      await this.sessions.findActiveAnchoredBefore(
        new Date(now - this.maxDurationSeconds * 1000),
        BATCH_SIZE,
      ),
      'MAX_DURATION_REACHED',
    );
  }

  private async settleAll(
    candidates: readonly ISessionRecord[],
    reason: SessionEndReason,
  ): Promise<void> {
    let swept = 0;
    for (const candidate of candidates) {
      try {
        // Null means a participant got there first between the query and this call — the
        // common case at second 30, and not worth logging.
        if (await this.lifecycle.terminate(candidate.id, reason)) swept += 1;
      } catch (error) {
        // Per-item isolation: one wedged session must not abort the batch and leave every
        // other expired call ringing. Not marking it means the next tick retries.
        this.logger.error(
          `Failed to sweep session ${candidate.id} (${reason}): ${describe(error)}`,
        );
      }
    }

    if (swept > 0) {
      this.logger.log({
        event: 'session.swept',
        reason,
        count: swept,
        candidates: candidates.length,
      });
    }
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
