import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { LeaderLockService } from '../../../infra/redis/leader-lock.service';
import type { IWebhookEventRepo } from '../../domain/repos/session.repos';
import { WEBHOOK_EVENT_REPO } from '../../tokens';
import { LiveKitWebhookProcessor } from '../services/livekit-webhook.processor';

const BATCH_SIZE = 50;

/**
 * The other half of "return 200, then process".
 *
 * The webhook controller responds before doing the work, so anything that dies between the
 * inbox insert and `markProcessed` leaves a row with a null `processedAt`. LiveKit will not
 * retry it — we already told them 200 — so this is the only thing that will. Without it,
 * "accept durably and process asynchronously" is just "drop the event more slowly".
 *
 * `MAX_ATTEMPTS` is what stops a poison event from being retried forever. An event that
 * exhausts its attempts stays in the table with its `lastError` rather than being deleted:
 * the point of an inbox is that the evidence outlives the failure.
 */
const MAX_ATTEMPTS = 8;

@Injectable()
export class WebhookRetryScheduler {
  private readonly logger = new Logger(WebhookRetryScheduler.name);

  constructor(
    @Inject(WEBHOOK_EVENT_REPO) private readonly inbox: IWebhookEventRepo,
    private readonly processor: LiveKitWebhookProcessor,
    private readonly leaderLock: LeaderLockService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async retry(): Promise<void> {
    try {
      await this.leaderLock.withLock('webhooks:retry', () => this.run());
    } catch (error) {
      this.logger.warn(
        `Webhook retry tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async run(): Promise<void> {
    const pending = await this.inbox.findUnprocessed(BATCH_SIZE, MAX_ATTEMPTS);
    if (pending.length === 0) return;

    for (const event of pending) {
      // `process` never throws — it records the failure and bumps the attempt counter itself,
      // so a single bad event cannot abort the batch.
      await this.processor.process(event);
    }

    this.logger.log({ event: 'livekit.webhook.retried', count: pending.length });
  }
}
