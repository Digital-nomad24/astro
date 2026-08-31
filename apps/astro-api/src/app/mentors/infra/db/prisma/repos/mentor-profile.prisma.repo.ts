import { Injectable } from '@nestjs/common';
import type { MentorApprovalStatus, MentorSort } from '@astro/contracts';
import { BOOKABLE_MENTOR_APPROVAL_STATUS } from '@astro/contracts';

import { PrismaService } from 'prisma/prisma.service';
import type { PageCursor } from '../../../../../common/pagination/cursor';
import type {
  IRatingDeltaParams,
  ICreateMentorProfileParams,
  IMentorListFilters,
  IMentorProfileRecord,
  IMentorProfileRepo,
  IReviewApplicationParams,
  IUpdateMentorProfileParams,
  IUpdatePresenceParams,
} from '../../../../domain/repos/mentor.repos';

const WITH_CATEGORY = {
  category: { select: { slug: true, name: true } },
} as const;

/** Row shape returned by every query in here — the model plus the joined category labels. */
type ProfileRow = {
  id: string;
  userId: string;
  categoryId: string;
  displayName: string;
  headline: string | null;
  bio: string | null;
  languages: string[];
  experienceYears: number;
  ratePaisePerMinute: number;
  approvalStatus: MentorApprovalStatus;
  approvalNote: string | null;
  approvedAt: Date | null;
  presenceState: 'OFFLINE' | 'ONLINE' | 'BUSY';
  acceptingNewCalls: boolean;
  queueDepth: number;
  ratingAvg: number;
  ratingCount: number;
  ratingSum: number;
  totalSessions: number;
  createdAt: Date;
  category: { slug: string; name: string };
};

/** Which column each sort option seeks on, and in which direction. */
const SORT_COLUMN: Record<MentorSort, { field: keyof ProfileRow; desc: boolean }> = {
  RATING: { field: 'ratingAvg', desc: true },
  PRICE_ASC: { field: 'ratePaisePerMinute', desc: false },
  PRICE_DESC: { field: 'ratePaisePerMinute', desc: true },
  NEWEST: { field: 'createdAt', desc: true },
};

@Injectable()
export class MentorProfilePrismaRepo implements IMentorProfileRepo {
  constructor(private readonly prisma: PrismaService) {}

  async listBookable(filters: IMentorListFilters): Promise<IMentorProfileRecord[]> {
    const { field, desc } = SORT_COLUMN[filters.sort];

    const where: Record<string, unknown> = {
      // Leading column of every browse index, and the reason a suspended mentor vanishes from
      // the catalogue the instant an admin acts.
      approvalStatus: BOOKABLE_MENTOR_APPROVAL_STATUS,
      ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
      // "Online" for browsing means reachable, which includes BUSY — a busy mentor is exactly
      // who the queue exists for. Excluding them would hide the mentors people most want.
      ...(filters.onlineOnly ? { presenceState: { in: ['ONLINE', 'BUSY'] } } : {}),
      ...(filters.maxRatePaisePerMinute !== undefined
        ? { ratePaisePerMinute: { lte: filters.maxRatePaisePerMinute } }
        : {}),
      ...(filters.language ? { languages: { has: filters.language } } : {}),
      ...(filters.search
        ? {
            OR: [
              { displayName: { contains: filters.search, mode: 'insensitive' } },
              { headline: { contains: filters.search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...keysetPredicate(field, desc, filters.cursor),
    };

    const rows = await this.prisma.mentorProfile.findMany({
      where: where as never,
      include: WITH_CATEGORY,
      orderBy: [{ [field]: desc ? 'desc' : 'asc' }, { id: desc ? 'desc' : 'asc' }] as never,
      // One extra row is how `toPage` knows another page exists, without a COUNT over the
      // whole filtered set.
      take: filters.limit + 1,
    });

    return rows.map(toRecord);
  }

  async listByApprovalStatus(
    status: MentorApprovalStatus,
    limit: number,
    cursor: PageCursor | null,
  ): Promise<IMentorProfileRecord[]> {
    const rows = await this.prisma.mentorProfile.findMany({
      where: {
        approvalStatus: status,
        ...keysetPredicate('createdAt', false, cursor),
      } as never,
      include: WITH_CATEGORY,
      // Oldest first: a moderation queue is a queue, and the longest-waiting applicant is next.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });

    return rows.map(toRecord);
  }

  async findById(id: string): Promise<IMentorProfileRecord | null> {
    const row = await this.prisma.mentorProfile.findUnique({
      where: { id },
      include: WITH_CATEGORY,
    });
    return row ? toRecord(row) : null;
  }

  async findByUserId(userId: string): Promise<IMentorProfileRecord | null> {
    const row = await this.prisma.mentorProfile.findUnique({
      where: { userId },
      include: WITH_CATEGORY,
    });
    return row ? toRecord(row) : null;
  }

  async create(params: ICreateMentorProfileParams): Promise<IMentorProfileRecord> {
    const row = await this.prisma.mentorProfile.create({
      data: {
        userId: params.userId,
        categoryId: params.categoryId,
        displayName: params.displayName,
        headline: params.headline ?? null,
        bio: params.bio ?? null,
        languages: params.languages,
        experienceYears: params.experienceYears,
        ratePaisePerMinute: params.ratePaisePerMinute,
      },
      include: WITH_CATEGORY,
    });
    return toRecord(row);
  }

  async update(id: string, params: IUpdateMentorProfileParams): Promise<IMentorProfileRecord> {
    const row = await this.prisma.mentorProfile.update({
      where: { id },
      // Only supplied keys are written, so `undefined` never clears a column.
      data: {
        ...(params.categoryId !== undefined ? { categoryId: params.categoryId } : {}),
        ...(params.displayName !== undefined ? { displayName: params.displayName } : {}),
        ...(params.headline !== undefined ? { headline: params.headline } : {}),
        ...(params.bio !== undefined ? { bio: params.bio } : {}),
        ...(params.languages !== undefined ? { languages: params.languages } : {}),
        ...(params.experienceYears !== undefined
          ? { experienceYears: params.experienceYears }
          : {}),
        ...(params.ratePaisePerMinute !== undefined
          ? { ratePaisePerMinute: params.ratePaisePerMinute }
          : {}),
      },
      include: WITH_CATEGORY,
    });
    return toRecord(row);
  }

  async updatePresence(params: IUpdatePresenceParams): Promise<void> {
    // `updateMany`, not `update`: a mentor deleted between the Redis write and this one would
    // make `update` throw P2025, and a missing read-model row is not worth failing a
    // presence transition over.
    await this.prisma.mentorProfile.updateMany({
      where: { id: params.mentorProfileId },
      data: {
        presenceState: params.presenceState,
        presenceUpdatedAt: new Date(),
        ...(params.acceptingNewCalls !== undefined
          ? { acceptingNewCalls: params.acceptingNewCalls }
          : {}),
        ...(params.queueDepth !== undefined ? { queueDepth: params.queueDepth } : {}),
      },
    });
  }

  /**
   * `updateMany` with atomic increments, so two sessions ending at the same instant both
   * count. A read-modify-write here would silently lose one, and the ETA it feeds would drift
   * further from reality the busier the mentor got.
   */
  async recordCompletedSession(mentorProfileId: string, billedSeconds: number): Promise<void> {
    await this.prisma.mentorProfile.updateMany({
      where: { id: mentorProfileId },
      data: {
        totalSessions: { increment: 1 },
        totalBilledSeconds: { increment: Math.max(0, billedSeconds) },
      },
    });
  }

  /**
   * Raw SQL, and it has to be.
   *
   * Prisma can express `{ increment }` but not "set this column to a function of the columns
   * you just incremented". Doing it in two statements — increment, then read, then divide —
   * reintroduces the read-modify-write this exists to avoid: two concurrent reviews would each
   * compute an average from a sum the other had already changed.
   *
   * `GREATEST(..., 0)` on the count is a floor, not arithmetic. If drift ever made the count
   * negative, an unguarded divide would produce a negative average and sort that mentor to the
   * very top of the catalogue — a bug that advertises itself on the front page.
   */
  async applyRatingDelta(params: IRatingDeltaParams): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "MentorProfile"
      SET "ratingSum"   = GREATEST("ratingSum" + ${params.sumDelta}, 0),
          "ratingCount" = GREATEST("ratingCount" + ${params.countDelta}, 0),
          "ratingAvg"   = CASE
            WHEN GREATEST("ratingCount" + ${params.countDelta}, 0) = 0 THEN 0
            ELSE GREATEST("ratingSum" + ${params.sumDelta}, 0)::float
                 / GREATEST("ratingCount" + ${params.countDelta}, 0)
          END
      WHERE "id" = ${params.mentorProfileId}
    `;
  }

  async setRatingAggregate(params: {
    mentorProfileId: string;
    ratingSum: number;
    ratingCount: number;
  }): Promise<void> {
    await this.prisma.mentorProfile.updateMany({
      where: { id: params.mentorProfileId },
      data: {
        ratingSum: params.ratingSum,
        ratingCount: params.ratingCount,
        ratingAvg: params.ratingCount > 0 ? params.ratingSum / params.ratingCount : 0,
      },
    });
  }

  async averageSessionSeconds(mentorProfileId: string): Promise<number | null> {
    const row = await this.prisma.mentorProfile.findUnique({
      where: { id: mentorProfileId },
      select: { totalSessions: true, totalBilledSeconds: true },
    });
    if (!row || row.totalSessions === 0) return null;
    return Math.round(row.totalBilledSeconds / row.totalSessions);
  }

  async reviewApplication(params: IReviewApplicationParams): Promise<IMentorProfileRecord> {
    const row = await this.prisma.mentorProfile.update({
      where: { id: params.mentorProfileId },
      data: {
        approvalStatus: params.status,
        approvalNote: params.note,
        approvedByUserId: params.reviewedByUserId,
        // Stamped on approval only. A rejection or suspension is not an approval date, and
        // clearing it on suspension would erase when they were originally let in.
        ...(params.status === 'APPROVED' ? { approvedAt: new Date() } : {}),
      },
      include: WITH_CATEGORY,
    });
    return toRecord(row);
  }
}

/**
 * The seek predicate: "strictly after the cursor row, in this sort order".
 *
 * Expressed as `(sortCol < v) OR (sortCol = v AND id < id)` for a descending sort, and the
 * mirror for ascending. The second clause is what makes ordering total — without it, rows
 * sharing a sort value (every mentor with a 4.5 rating, every mentor at the same price) would
 * be skipped or repeated across page boundaries.
 */
function keysetPredicate(
  field: string,
  desc: boolean,
  cursor: PageCursor | null,
): Record<string, unknown> {
  if (!cursor) return {};

  const beyond = desc ? 'lt' : 'gt';
  return {
    OR: [
      { [field]: { [beyond]: cursor.v } },
      { AND: [{ [field]: cursor.v }, { id: { [beyond]: cursor.id } }] },
    ],
  };
}

const toRecord = (row: ProfileRow): IMentorProfileRecord => ({
  id: row.id,
  userId: row.userId,
  categoryId: row.categoryId,
  categorySlug: row.category.slug,
  categoryName: row.category.name,
  displayName: row.displayName,
  headline: row.headline,
  bio: row.bio,
  languages: row.languages,
  experienceYears: row.experienceYears,
  ratePaisePerMinute: row.ratePaisePerMinute,
  approvalStatus: row.approvalStatus,
  approvalNote: row.approvalNote,
  approvedAt: row.approvedAt,
  presenceState: row.presenceState,
  acceptingNewCalls: row.acceptingNewCalls,
  queueDepth: row.queueDepth,
  ratingAvg: row.ratingAvg,
  ratingCount: row.ratingCount,
  ratingSum: row.ratingSum,
  totalSessions: row.totalSessions,
  createdAt: row.createdAt,
});

export { SORT_COLUMN };
