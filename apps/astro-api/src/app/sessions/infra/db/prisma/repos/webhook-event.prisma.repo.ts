import { Injectable } from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';
import type {
  IRecordWebhookEventParams,
  IWebhookEventRecord,
  IWebhookEventRepo,
} from '../../../../domain/repos/session.repos';

type WebhookRow = {
  id: string;
  source: string;
  eventId: string;
  eventType: string;
  roomName: string | null;
  participantIdentity: string | null;
  sessionId: string | null;
  payload: unknown;
  receivedAt: Date;
  processedAt: Date | null;
  attempts: number;
  lastError: string | null;
};

@Injectable()
export class WebhookEventPrismaRepo implements IWebhookEventRepo {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The house idempotency primitive: `createMany({ skipDuplicates: true })` against the
   * `@@unique([source, eventId])`, reading `count > 0` as "this delivery was the first one".
   *
   * A plain `create` in a try/catch would work too, but it burns a transaction on every
   * redelivery and makes a normal, expected event look like an error in the logs. LiveKit
   * redelivers routinely; that must be the quiet path.
   *
   * The row is then read back unconditionally, because the caller needs the id whether it just
   * inserted the row or is looking at one from a delivery two seconds ago.
   */
  async record(
    params: IRecordWebhookEventParams,
  ): Promise<{ isNew: boolean; event: IWebhookEventRecord }> {
    const inserted = await this.prisma.webhookEvent.createMany({
      data: [
        {
          source: params.source,
          eventId: params.eventId,
          eventType: params.eventType,
          roomName: params.roomName,
          participantIdentity: params.participantIdentity,
          sessionId: params.sessionId,
          payload: params.payload as never,
        },
      ],
      skipDuplicates: true,
    });

    const row = await this.prisma.webhookEvent.findUnique({
      where: { source_eventId: { source: params.source, eventId: params.eventId } },
    });
    if (!row) {
      // Only reachable if the row was deleted between the insert and this read, which nothing
      // in this system does. Loud rather than a silent null the caller has to handle.
      throw new Error(
        `Webhook event ${params.source}/${params.eventId} vanished immediately after insert.`,
      );
    }

    return { isNew: inserted.count > 0, event: toRecord(row) };
  }

  async markProcessed(id: string): Promise<void> {
    await this.prisma.webhookEvent.updateMany({
      where: { id },
      data: { processedAt: new Date(), lastError: null },
    });
  }

  /**
   * Records the failure and bumps the attempt counter, leaving `processedAt` null so the sweep
   * picks it up again. The counter is what stops a poison event retrying forever — the sweep
   * filters on it, and an event that exhausts its attempts stays in the table as evidence
   * rather than being deleted.
   */
  async markFailed(id: string, error: string): Promise<void> {
    await this.prisma.webhookEvent.updateMany({
      where: { id },
      data: { attempts: { increment: 1 }, lastError: error.slice(0, 1000) },
    });
  }

  async findUnprocessed(limit: number, maxAttempts: number): Promise<IWebhookEventRecord[]> {
    const rows = await this.prisma.webhookEvent.findMany({
      where: { processedAt: null, attempts: { lt: maxAttempts } },
      orderBy: { receivedAt: 'asc' },
      take: limit,
    });
    return rows.map(toRecord);
  }
}

const toRecord = (row: WebhookRow): IWebhookEventRecord => ({
  id: row.id,
  source: row.source,
  eventId: row.eventId,
  eventType: row.eventType,
  roomName: row.roomName,
  participantIdentity: row.participantIdentity,
  sessionId: row.sessionId,
  payload: row.payload,
  receivedAt: row.receivedAt,
  processedAt: row.processedAt,
  attempts: row.attempts,
  lastError: row.lastError,
});
