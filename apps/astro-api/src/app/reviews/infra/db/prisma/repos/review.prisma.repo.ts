import { Injectable } from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';
import type { PageCursor } from '../../../../../common/pagination/cursor';
import type {
  IRatingTruth,
  IReviewRecord,
  IReviewRepo,
  IUpsertReviewParams,
  IUpsertReviewResult,
} from '../../../../domain/repos/review.repos';

type ReviewRow = {
  id: string;
  sessionId: string;
  mentorProfileId: string;
  authorUserId: string;
  authorDisplayName: string | null;
  rating: number;
  comment: string | null;
  isHidden: boolean;
  hiddenReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class ReviewPrismaRepo implements IReviewRepo {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The review and the aggregate, or neither.
   *
   * The previous rating is read **inside** the transaction rather than taken from the caller,
   * because the delta is a function of it: an edit from 2 stars to 5 is `+3` with no change to
   * the count. A stale value read before the transaction would apply the wrong delta and leave
   * the aggregate permanently off by the difference — visible only to the nightly reconciler.
   *
   * A hidden review that gets edited stays out of the aggregate: it contributes nothing now, so
   * changing it changes nothing. Un-hiding is the only thing that puts it back, and that is
   * `setHidden`'s job.
   */
  async upsert(params: IUpsertReviewParams): Promise<IUpsertReviewResult> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.review.findUnique({
        where: { sessionId: params.sessionId },
      });

      const row = existing
        ? await tx.review.update({
            where: { sessionId: params.sessionId },
            data: { rating: params.rating, comment: params.comment },
          })
        : await tx.review.create({
            data: {
              sessionId: params.sessionId,
              mentorProfileId: params.mentorProfileId,
              authorUserId: params.authorUserId,
              authorDisplayName: params.authorDisplayName,
              rating: params.rating,
              comment: params.comment,
            },
          });

      // A hidden review contributes nothing, so editing it moves nothing.
      const countsTowardAggregate = !row.isHidden;
      if (countsTowardAggregate) {
        const sumDelta = existing ? params.rating - existing.rating : params.rating;
        const countDelta = existing ? 0 : 1;
        await applyRatingDelta(tx, params.mentorProfileId, sumDelta, countDelta);
      }

      return { review: toRecord(row), created: existing === null };
    });
  }

  async findBySessionId(sessionId: string): Promise<IReviewRecord | null> {
    const row = await this.prisma.review.findUnique({ where: { sessionId } });
    return row ? toRecord(row) : null;
  }

  async listForMentor(
    mentorProfileId: string,
    limit: number,
    cursor: PageCursor | null,
  ): Promise<IReviewRecord[]> {
    const anchor = cursor ? String(cursor.v) : null;

    const rows = await this.prisma.review.findMany({
      where: {
        mentorProfileId,
        // Hidden reviews are invisible to everyone, including their author. A moderated review
        // that the author can still see reads as "shadow-banned", which is worse than telling
        // them plainly — but the telling belongs in a notification, not in this list.
        isHidden: false,
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

  async distributionFor(mentorProfileId: string): Promise<Record<number, number>> {
    const grouped = await this.prisma.review.groupBy({
      by: ['rating'],
      where: { mentorProfileId, isHidden: false },
      _count: { _all: true },
    });

    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const bucket of grouped) distribution[bucket.rating] = bucket._count._all;
    return distribution;
  }

  /**
   * Scoped to the current visibility, so a double-hide is a no-op rather than subtracting the
   * rating twice. That is the same compare-and-swap the session transitions use, applied to a
   * boolean.
   */
  async setHidden(params: {
    reviewId: string;
    hidden: boolean;
    reason: string | null;
    byUserId: string;
  }): Promise<IReviewRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.review.updateMany({
        where: { id: params.reviewId, isHidden: !params.hidden },
        data: {
          isHidden: params.hidden,
          // The CHECK requires a reason whenever hidden; clearing it on unhide keeps the row
          // from claiming a moderation that is no longer in force.
          hiddenReason: params.hidden ? (params.reason ?? 'Hidden by an administrator') : null,
          hiddenByUserId: params.hidden ? params.byUserId : null,
        },
      });
      if (updated.count === 0) return null;

      const row = await tx.review.findUnique({ where: { id: params.reviewId } });
      if (!row) return null;

      // Hiding removes the review's contribution; unhiding restores it.
      const sign = params.hidden ? -1 : 1;
      await applyRatingDelta(tx, row.mentorProfileId, sign * row.rating, sign);

      return toRecord(row);
    });
  }

  /**
   * One grouped query for the whole catalogue rather than a query per mentor. The reconciler
   * runs nightly over every mentor with reviews, and N round trips would make it slower than
   * the window it runs in.
   */
  async deriveRatingTruth(): Promise<IRatingTruth[]> {
    const grouped = await this.prisma.review.groupBy({
      by: ['mentorProfileId'],
      where: { isHidden: false },
      _sum: { rating: true },
      _count: { _all: true },
    });

    return grouped.map((row) => ({
      mentorProfileId: row.mentorProfileId,
      ratingSum: row._sum.rating ?? 0,
      ratingCount: row._count._all,
    }));
  }
}

/**
 * The aggregate update, duplicated here rather than reached through `IMentorProfileRepo`.
 *
 * It has to run on the *transaction client* — calling the mentors repo would use its own
 * connection and commit independently, which is precisely the atomicity this design exists to
 * guarantee. The SQL is identical to `MentorProfilePrismaRepo.applyRatingDelta`; that one
 * serves callers outside a transaction, and `test/reviews.e2e-spec.ts` asserts the invariant
 * both of them maintain.
 */
async function applyRatingDelta(
  tx: { $executeRaw: PrismaService['$executeRaw'] },
  mentorProfileId: string,
  sumDelta: number,
  countDelta: number,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "MentorProfile"
    SET "ratingSum"   = GREATEST("ratingSum" + ${sumDelta}, 0),
        "ratingCount" = GREATEST("ratingCount" + ${countDelta}, 0),
        "ratingAvg"   = CASE
          WHEN GREATEST("ratingCount" + ${countDelta}, 0) = 0 THEN 0
          ELSE GREATEST("ratingSum" + ${sumDelta}, 0)::float
               / GREATEST("ratingCount" + ${countDelta}, 0)
        END
    WHERE "id" = ${mentorProfileId}
  `;
}

const toRecord = (row: ReviewRow): IReviewRecord => ({
  id: row.id,
  sessionId: row.sessionId,
  mentorProfileId: row.mentorProfileId,
  authorUserId: row.authorUserId,
  authorDisplayName: row.authorDisplayName,
  rating: row.rating,
  comment: row.comment,
  isHidden: row.isHidden,
  hiddenReason: row.hiddenReason,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
