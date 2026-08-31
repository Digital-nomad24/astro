import { Injectable } from '@nestjs/common';
import type { QueueLeaveReason, SessionMode } from '@astro/contracts';

import { PrismaService } from 'prisma/prisma.service';
import type {
  ICreateQueueEntryParams,
  IQueueEntryRecord,
  IQueueEntryRepo,
} from '../../../../domain/repos/queue.repos';

type QueueRow = {
  id: string;
  sessionId: string;
  mentorProfileId: string;
  userId: string;
  mode: SessionMode;
  status: 'WAITING' | 'PROMOTED' | 'CANCELLED' | 'EXPIRED';
  enqueuedAt: Date;
  disconnectedAt: Date | null;
  promotedAt: Date | null;
  leftAt: Date | null;
  leaveReason: string | null;
};

@Injectable()
export class QueueEntryPrismaRepo implements IQueueEntryRepo {
  constructor(private readonly prisma: PrismaService) {}

  async create(params: ICreateQueueEntryParams): Promise<IQueueEntryRecord> {
    const row = await this.prisma.queueEntry.create({
      data: {
        sessionId: params.sessionId,
        mentorProfileId: params.mentorProfileId,
        userId: params.userId,
        mode: params.mode,
        // Explicit rather than defaulted, because this value IS the sorted-set score. The
        // database default and the score Redis receives must be the same instant.
        enqueuedAt: params.enqueuedAt,
      },
    });
    return toRecord(row);
  }

  async findBySessionId(sessionId: string): Promise<IQueueEntryRecord | null> {
    const row = await this.prisma.queueEntry.findUnique({ where: { sessionId } });
    return row ? toRecord(row) : null;
  }

  async findWaitingForMentor(mentorProfileId: string): Promise<IQueueEntryRecord[]> {
    const rows = await this.prisma.queueEntry.findMany({
      where: { mentorProfileId, status: 'WAITING' },
      orderBy: { enqueuedAt: 'asc' },
    });
    return rows.map(toRecord);
  }

  async findAllWaiting(limit: number): Promise<IQueueEntryRecord[]> {
    const rows = await this.prisma.queueEntry.findMany({
      where: { status: 'WAITING' },
      orderBy: { enqueuedAt: 'asc' },
      take: limit,
    });
    return rows.map(toRecord);
  }

  async findMentorsWithWaiting(): Promise<string[]> {
    const rows = await this.prisma.queueEntry.findMany({
      where: { status: 'WAITING' },
      distinct: ['mentorProfileId'],
      select: { mentorProfileId: true },
    });
    return rows.map((row) => row.mentorProfileId);
  }

  /**
   * Compare-and-swap out of WAITING.
   *
   * Scoped to `status: 'WAITING'`, so a promotion that races the TTL sweep produces exactly one
   * winner and the loser gets null. That collision is routine rather than exceptional: a user
   * at the head of the queue is simultaneously the most likely to be promoted and, if they have
   * been waiting the full thirty minutes, the most likely to be expired.
   */
  async leave(params: {
    sessionId: string;
    status: 'PROMOTED' | 'CANCELLED' | 'EXPIRED';
    reason: QueueLeaveReason;
    at: Date;
  }): Promise<IQueueEntryRecord | null> {
    const updated = await this.prisma.queueEntry.updateMany({
      where: { sessionId: params.sessionId, status: 'WAITING' },
      data: {
        status: params.status,
        leftAt: params.at,
        leaveReason: params.reason,
        // The CHECK constraint requires promotedAt to be set exactly when status is PROMOTED.
        ...(params.status === 'PROMOTED' ? { promotedAt: params.at } : {}),
      },
    });
    if (updated.count === 0) return null;

    return this.findBySessionId(params.sessionId);
  }

  /**
   * PROMOTED → WAITING, clearing every departure field so the `QueueEntry_waiting_has_not_left`
   * CHECK is satisfied. `enqueuedAt` is untouched, which is the whole point: the user keeps the
   * score they arrived with and lands back in their original place.
   */
  async reinstate(sessionId: string): Promise<IQueueEntryRecord | null> {
    const updated = await this.prisma.queueEntry.updateMany({
      where: { sessionId, status: 'PROMOTED' },
      data: { status: 'WAITING', leftAt: null, leaveReason: null, promotedAt: null },
    });
    if (updated.count === 0) return null;
    return this.findBySessionId(sessionId);
  }

  /**
   * Applied to every WAITING entry the user has, which by the partial unique index is at most
   * one — written as `updateMany` so a user with no entry is a no-op rather than a P2025.
   */
  async setDisconnectedAt(userId: string, at: Date | null): Promise<void> {
    await this.prisma.queueEntry.updateMany({
      where: { userId, status: 'WAITING' },
      data: { disconnectedAt: at },
    });
  }

  async findWaitingEnqueuedBefore(cutoff: Date, limit: number): Promise<IQueueEntryRecord[]> {
    const rows = await this.prisma.queueEntry.findMany({
      where: { status: 'WAITING', enqueuedAt: { lt: cutoff } },
      orderBy: { enqueuedAt: 'asc' },
      take: limit,
    });
    return rows.map(toRecord);
  }

  async findWaitingDisconnectedBefore(cutoff: Date, limit: number): Promise<IQueueEntryRecord[]> {
    const rows = await this.prisma.queueEntry.findMany({
      where: { status: 'WAITING', disconnectedAt: { lt: cutoff } },
      orderBy: { disconnectedAt: 'asc' },
      take: limit,
    });
    return rows.map(toRecord);
  }
}

const toRecord = (row: QueueRow): IQueueEntryRecord => ({
  id: row.id,
  sessionId: row.sessionId,
  mentorProfileId: row.mentorProfileId,
  userId: row.userId,
  mode: row.mode,
  status: row.status,
  enqueuedAt: row.enqueuedAt,
  disconnectedAt: row.disconnectedAt,
  promotedAt: row.promotedAt,
  leftAt: row.leftAt,
  leaveReason: row.leaveReason,
});
