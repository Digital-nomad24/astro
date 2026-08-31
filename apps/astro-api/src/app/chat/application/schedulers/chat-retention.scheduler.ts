import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import type { EnvVars } from '../../../../config/env.schema';
import { LeaderLockService } from '../../../infra/redis/leader-lock.service';
import type { IChatMessageRepo, IPurgeCandidate } from '../../domain/repos/chat.repos';
import { CHAT_MESSAGE_REPO } from '../../tokens';
import { ChatGateway } from '../../entry-points/sockets/chat.gateway';

const BATCH_SIZE = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes chat transcripts once they have served their purpose.
 *
 * The policy, in one line: **keep a transcript for `CHAT_RETENTION_DAYS` after the session
 * ends, summarise it, then delete it — and delete it regardless after
 * `CHAT_HARD_DELETE_DAYS`.** Both halves are necessary and neither is sufficient.
 * Delete-on-summarise alone leaks every transcript whose summary failed, forever.
 * Delete-on-schedule alone destroys content before anything has extracted its meaning. This is
 * the same shape as the audio retention in §7 of the plan, for the same reasons.
 *
 * What survives a purge is deliberate: the summary (M8), `messageCount`, `billingAnchorAt`,
 * and who spoke to whom. What does not is the text itself. A summary of a consultation is
 * still sensitive personal data with its own retention and access rules — deleting the
 * transcript reduces that obligation, it does not remove it.
 *
 * **While M8 is outstanding, nothing can produce a summary**, so every completed chat reaches
 * the backstop un-summarised and is deleted with its content unread. That is a deliberate
 * choice of bounded data loss over an unbounded store of personal data; raise
 * `CHAT_HARD_DELETE_DAYS` if M8 slips well past a month.
 */
@Injectable()
export class ChatRetentionScheduler {
  private readonly logger = new Logger(ChatRetentionScheduler.name);
  private readonly retentionDays: number;
  private readonly hardDeleteDays: number;

  constructor(
    @Inject(CHAT_MESSAGE_REPO) private readonly messages: IChatMessageRepo,
    private readonly gateway: ChatGateway,
    private readonly leaderLock: LeaderLockService,
    config: ConfigService<EnvVars, true>,
  ) {
    this.retentionDays = config.get('CHAT_RETENTION_DAYS', { infer: true });
    this.hardDeleteDays = config.get('CHAT_HARD_DELETE_DAYS', { infer: true });
  }

  /**
   * Hourly. Retention is measured in days, so a tighter schedule would only add load — and a
   * looser one would make the advertised deletion date visibly wrong.
   *
   * Leader-locked like every other cron here. Unlike the billing sweeper, a double run would
   * not double-charge anything — `purgeTranscript` is idempotent — but it would double the
   * delete load and write a second audit line for work that did not happen.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async sweep(): Promise<void> {
    try {
      await this.leaderLock.withLock('chat:retention-sweep', () => this.run(), 300);
    } catch (error) {
      this.logger.warn(`Chat retention sweep tick failed: ${describe(error)}`);
    }
  }

  private async run(): Promise<void> {
    const now = Date.now();
    const candidates = await this.messages.findPurgeableTranscripts({
      retentionCutoff: new Date(now - this.retentionDays * DAY_MS),
      hardCutoff: new Date(now - this.hardDeleteDays * DAY_MS),
      limit: BATCH_SIZE,
    });
    if (candidates.length === 0) return;

    let purged = 0;
    let deletedMessages = 0;
    let backstopped = 0;

    for (const candidate of candidates) {
      try {
        const at = new Date();
        const removed = await this.messages.purgeTranscript(candidate.sessionId, at);

        purged += 1;
        deletedMessages += removed;
        if (candidate.reason === 'RETENTION_BACKSTOP') backstopped += 1;

        this.audit(candidate, removed);
        // For the rare client holding the transcript open across the whole window. Without
        // it, that pane would keep showing messages the server no longer has.
        this.gateway.announcePurge(candidate.sessionId, at, candidate.messageCount);
      } catch (error) {
        // Per-item isolation, and not clearing anything on failure means the next tick retries.
        this.logger.error(
          `Failed to purge transcript for session ${candidate.sessionId}: ${describe(error)}`,
        );
      }
    }

    this.logger.log({
      event: 'chat.transcripts_purged',
      sessions: purged,
      messages: deletedMessages,
      backstopped,
      candidates: candidates.length,
      // Logged so a truncated batch is visible. A silent cap reads as "we purged everything
      // due" when in fact there is a backlog the next tick has to chew through.
      truncated: candidates.length === BATCH_SIZE,
    });
  }

  /**
   * One line per deleted transcript.
   *
   * This is the only remaining evidence that the content ever existed, so it records what was
   * destroyed and under which arm of the policy — never the content itself. A backstop purge
   * is logged at warn: it means a transcript was destroyed without anything having read it,
   * which is the outcome the policy exists to make rare.
   */
  private audit(candidate: IPurgeCandidate, removed: number): void {
    const entry = {
      event: 'chat.transcript_purged',
      sessionId: candidate.sessionId,
      reason: candidate.reason,
      messagesDeleted: removed,
      endedAt: candidate.endedAt.toISOString(),
    };

    if (candidate.reason === 'RETENTION_BACKSTOP') {
      this.logger.warn({
        ...entry,
        note: 'Transcript deleted with no summary — the content is gone unread.',
      });
      return;
    }
    this.logger.log(entry);
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
