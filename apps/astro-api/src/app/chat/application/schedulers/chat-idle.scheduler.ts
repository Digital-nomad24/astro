import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import type { EnvVars } from '../../../../config/env.schema';
import { LeaderLockService } from '../../../infra/redis/leader-lock.service';
import { SessionLifecycleService } from '../../../sessions/application/services/session-lifecycle.service';
import type { IChatMessageRepo } from '../../domain/repos/chat.repos';
import { CHAT_MESSAGE_REPO } from '../../tokens';

const BATCH_SIZE = 100;

/**
 * Ends text sessions that have gone quiet.
 *
 * **This is the only backstop a text session has.** A voice call has `room_finished` from
 * LiveKit and an empty room that LiveKit tears down on its own; a text session has neither.
 * Nothing outside this process knows the conversation stopped, so without this sweep a
 * forgotten browser tab holds an ACTIVE session forever — occupying both parties' in-flight
 * slots today, and draining a wallet a minute at a time once M10 lands.
 *
 * That is why it ships in M5 rather than with the billing it protects: the failure it prevents
 * is cheap to add now and expensive to discover later.
 */
@Injectable()
export class ChatIdleScheduler {
  private readonly logger = new Logger(ChatIdleScheduler.name);
  private readonly idleTimeoutSeconds: number;

  constructor(
    @Inject(CHAT_MESSAGE_REPO) private readonly messages: IChatMessageRepo,
    private readonly lifecycle: SessionLifecycleService,
    private readonly leaderLock: LeaderLockService,
    config: ConfigService<EnvVars, true>,
  ) {
    this.idleTimeoutSeconds = config.get('CHAT_IDLE_TIMEOUT_S', { infer: true });
  }

  /** Nothing may escape: an unhandled rejection from a `@Cron` takes the process down. */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async sweep(): Promise<void> {
    try {
      await this.leaderLock.withLock('chat:idle-sweep', () => this.run());
    } catch (error) {
      this.logger.warn(`Chat idle sweep tick failed: ${describe(error)}`);
    }
  }

  private async run(): Promise<void> {
    const cutoff = new Date(Date.now() - this.idleTimeoutSeconds * 1000);
    const idle = await this.messages.findIdleTextSessions(cutoff, BATCH_SIZE);
    if (idle.length === 0) return;

    let ended = 0;
    for (const candidate of idle) {
      try {
        // Null means a participant ended it between the query and here — the ordinary case,
        // not worth logging.
        const settled = await this.lifecycle.terminate(candidate.sessionId, 'IDLE_TIMEOUT');
        if (settled) ended += 1;
      } catch (error) {
        // Per-item isolation: one wedged session must not abort the batch and leave every
        // other abandoned conversation running.
        this.logger.error(
          `Failed to end idle chat session ${candidate.sessionId}: ${describe(error)}`,
        );
      }
    }

    if (ended > 0) {
      this.logger.log({
        event: 'chat.idle_timeout',
        count: ended,
        candidates: idle.length,
        idleTimeoutSeconds: this.idleTimeoutSeconds,
      });
    }
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
