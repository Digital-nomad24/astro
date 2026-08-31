import { Injectable } from '@nestjs/common';
import { ConflictError } from '@astro/errors';

import { PrismaService } from 'prisma/prisma.service';
import type { PageCursor } from '../../../../../common/pagination/cursor';
import type {
  IAppendMessageParams,
  IAppendMessageResult,
  IChatMessageRecord,
  IChatMessageRepo,
  IIdleSessionCandidate,
  IPurgeCandidate,
} from '../../../../domain/repos/chat.repos';

type MessageRow = {
  id: string;
  sessionId: string;
  senderUserId: string;
  body: string;
  clientMsgId: string;
  createdAt: Date;
};

@Injectable()
export class ChatMessagePrismaRepo implements IChatMessageRepo {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One transaction, four statements, and the order of the first two is the whole design.
   *
   * 1. **Insert first**, with `skipDuplicates` against `@@unique([sessionId, clientMsgId])`.
   *    `count === 0` means a client retried after a reconnect: return early having changed
   *    nothing. Doing this first is what keeps a retry from inflating `messageCount`.
   * 2. **Then the conditional counter bump**, scoped to `status: 'ACTIVE'`. `count === 0`
   *    means the session ended between the client deciding to send and this commit, and the
   *    throw rolls the insert back. This is a compare-and-swap, not a read-then-write: a check
   *    before the transaction could pass and still race the session ending.
   * 3. The anchor, stamped only if null — so the tenth message cannot move the meter's origin.
   */
  async append(params: IAppendMessageParams): Promise<IAppendMessageResult> {
    const existing = await this.prisma.$transaction(async (tx) => {
      const inserted = await tx.chatMessage.createMany({
        data: [
          {
            sessionId: params.sessionId,
            senderUserId: params.senderUserId,
            body: params.body,
            clientMsgId: params.clientMsgId,
            createdAt: params.at,
          },
        ],
        skipDuplicates: true,
      });

      if (inserted.count === 0) return { duplicate: true, anchored: false };

      const active = await tx.session.updateMany({
        where: { id: params.sessionId, status: 'ACTIVE' },
        data: { lastMessageAt: params.at, messageCount: { increment: 1 } },
      });
      if (active.count === 0) {
        throw new ConflictError(
          'SESSION_NOT_ACTIVE',
          'That conversation has ended, so no further messages can be sent.',
        );
      }

      // For TEXT this is where metering begins — the first message from either party, not the
      // accept. A mentor should not bill for the seconds a user spends deciding what to type.
      const anchor = await tx.session.updateMany({
        where: { id: params.sessionId, billingAnchorAt: null },
        data: { billingAnchorAt: params.at },
      });

      return { duplicate: false, anchored: anchor.count > 0 };
    });

    // Read back outside the transaction. On the duplicate path this is the row the first
    // attempt stored — which is what the client needs in order to reconcile its optimistic
    // bubble rather than render the message twice.
    const message = await this.prisma.chatMessage.findUnique({
      where: {
        sessionId_clientMsgId: {
          sessionId: params.sessionId,
          clientMsgId: params.clientMsgId,
        },
      },
    });
    if (!message) {
      throw new Error(
        `Chat message ${params.sessionId}/${params.clientMsgId} vanished immediately after insert.`,
      );
    }

    return { message: toRecord(message), ...existing };
  }

  async history(
    sessionId: string,
    limit: number,
    cursor: PageCursor | null,
  ): Promise<IChatMessageRecord[]> {
    // `PageCursor.v` is `string | number` because other cursors seek on numeric columns. Here
    // it is always the ISO timestamp the page encoded, and narrowing it once keeps Prisma's
    // DateTime filter — which accepts a string or a Date, but not a number — happy.
    const anchor = cursor ? String(cursor.v) : null;

    const rows = await this.prisma.chatMessage.findMany({
      where: {
        sessionId,
        // Seeking backwards through history on (createdAt, id). The id tiebreaker is not
        // optional — two messages can share a millisecond, and without it a page boundary
        // silently drops or repeats them.
        ...(cursor && anchor
          ? {
              OR: [
                { createdAt: { lt: anchor } },
                { AND: [{ createdAt: anchor }, { id: { lt: cursor.id } }] },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    return rows.map(toRecord);
  }

  /**
   * Idle means "no message since the cutoff". A session that has never had a message falls
   * back to `acceptedAt`, so a text consultation nobody ever typed in still ends — otherwise
   * it would sit ACTIVE forever holding both parties' in-flight slots.
   */
  async findIdleTextSessions(cutoff: Date, limit: number): Promise<IIdleSessionCandidate[]> {
    const rows = await this.prisma.session.findMany({
      where: {
        status: 'ACTIVE',
        mode: 'TEXT',
        OR: [
          { lastMessageAt: { lt: cutoff } },
          { lastMessageAt: null, acceptedAt: { lt: cutoff } },
        ],
      },
      select: { id: true, lastMessageAt: true, acceptedAt: true, createdAt: true },
      orderBy: { lastMessageAt: 'asc' },
      take: limit,
    });

    return rows.map((row) => ({
      sessionId: row.id,
      lastActivityAt: row.lastMessageAt ?? row.acceptedAt ?? row.createdAt,
    }));
  }

  async findPurgeableTranscripts(params: {
    retentionCutoff: Date;
    hardCutoff: Date;
    limit: number;
  }): Promise<IPurgeCandidate[]> {
    const rows = await this.prisma.session.findMany({
      where: {
        mode: 'TEXT',
        messagesPurgedAt: null,
        endedAt: { lt: params.retentionCutoff },
        // A session with nothing to delete is not a candidate — purging it would only cost a
        // write and make the audit log claim work that did not happen.
        messageCount: { gt: 0 },
      },
      select: { id: true, endedAt: true, messageCount: true, summaryIneligibleReason: true },
      orderBy: { endedAt: 'asc' },
      take: params.limit,
    });

    return rows.flatMap((row): IPurgeCandidate[] => {
      if (!row.endedAt) return [];

      // The intended path: past retention AND the transcript has served its purpose.
      //
      // Today that means only "a summary can never exist for this one" — M8 adds the
      // `SessionSummary.status === 'COMPLETE'` arm here, and this is the single method it has
      // to change. Until then every genuinely summarisable transcript waits for the backstop,
      // which is the honest behaviour: deleting a transcript before its summary exists would
      // destroy the content permanently.
      const summarySettled = row.summaryIneligibleReason !== null;
      if (summarySettled) {
        return [
          {
            sessionId: row.id,
            endedAt: row.endedAt,
            messageCount: row.messageCount,
            reason: 'SUMMARISED' as const,
          },
        ];
      }

      // The backstop. Nothing lives forever, summarised or not.
      if (row.endedAt < params.hardCutoff) {
        return [
          {
            sessionId: row.id,
            endedAt: row.endedAt,
            messageCount: row.messageCount,
            reason: 'RETENTION_BACKSTOP' as const,
          },
        ];
      }

      return [];
    });
  }

  /**
   * The delete and the stamp are one transaction: a crash between them would leave a session
   * whose transcript is gone but which still reports itself as retained, and the next sweep
   * would "purge" it again and log a second deletion that never happened.
   *
   * The stamp is scoped to `messagesPurgedAt: null`, so a re-run keeps the original timestamp
   * — the moment a transcript was destroyed is not a field to overwrite casually.
   */
  async purgeTranscript(sessionId: string, at: Date): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const deleted = await tx.chatMessage.deleteMany({ where: { sessionId } });
      await tx.session.updateMany({
        where: { id: sessionId, messagesPurgedAt: null },
        data: { messagesPurgedAt: at },
      });
      return deleted.count;
    });
  }
}

const toRecord = (row: MessageRow): IChatMessageRecord => ({
  id: row.id,
  sessionId: row.sessionId,
  senderUserId: row.senderUserId,
  body: row.body,
  clientMsgId: row.clientMsgId,
  createdAt: row.createdAt,
});
