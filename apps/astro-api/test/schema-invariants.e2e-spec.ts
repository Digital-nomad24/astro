import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';

import { AppModule } from '../src/app/app.module';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Guards the schema objects Prisma cannot see.
 *
 * Partial indexes and CHECK constraints have no representation in `schema.prisma`. They are
 * written by hand in migration SQL, which creates a specific hazard: because Prisma models
 * indexes, a future `migrate dev` will look at a partial index it never declared and propose
 * **dropping** it. Nothing about that is loud — the generated migration is just a
 * `DROP INDEX` among the ALTERs, and the constraint it removes is one that only fires under
 * concurrency, i.e. only in production.
 *
 * So the guarantees are asserted directly against `pg_indexes` and `pg_constraint`. If a
 * migration removes one, a test fails instead of a live invariant.
 */
describe('schema invariants', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
  }, 60_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
  });

  const indexDef = async (name: string): Promise<string | null> => {
    const rows = await prisma.$queryRawUnsafe<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
      name,
    );
    return rows[0]?.indexdef ?? null;
  };

  const constraintDef = async (name: string): Promise<string | null> => {
    const rows = await prisma.$queryRawUnsafe<{ def: string }[]>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
      name,
    );
    return rows[0]?.def ?? null;
  };

  describe('partial unique indexes', () => {
    it('allows a user at most one session INCLUDING one they are queued for', async () => {
      const def = await indexDef('session_one_inflight_per_user');
      expect(def).toContain('UNIQUE');
      expect(def).toContain('"userId"');
      expect(def).toContain('RINGING');
      expect(def).toContain('ACTIVE');
      // QUEUED matters here and nowhere else: without it one person could hold a place in
      // every mentor's line and be promoted into several calls at once, each promotion
      // individually valid.
      expect(def).toContain('QUEUED');
      // Scoped to the live statuses — a user's completed history must not collide.
      expect(def).not.toContain('COMPLETED');
    });

    it('allows a mentor one in-flight session but ANY number of queued ones', async () => {
      // Two instances race to promote from one queue against one free mentor. This index is
      // what makes exactly one of them win; the Lua dispatch lock only makes the race rare.
      const def = await indexDef('session_one_inflight_per_mentor');
      expect(def).toContain('UNIQUE');
      expect(def).toContain('"mentorProfileId"');
      expect(def).toContain('RINGING');
      expect(def).toContain('ACTIVE');
      // Deliberately absent: many users queue for one mentor, which is the whole point.
      expect(def).not.toContain('QUEUED');
    });

    it('allows a user at most one WAITING queue entry', async () => {
      // Backs up the session index on the queue's own table, because the reconciler rebuilds
      // Redis from THERE — a duplicate would put one user in the sorted set twice and they
      // would be promoted twice.
      const def = await indexDef('queue_entry_one_waiting_per_user');
      expect(def).toContain('UNIQUE');
      expect(def).toContain('"userId"');
      expect(def).toContain('WAITING');
    });

    it('keeps the webhook backlog index partial', async () => {
      // This table only grows. A full index on (processedAt, receivedAt) would grow with
      // history; this one stays the size of the backlog.
      const def = await indexDef('webhook_event_unprocessed');
      expect(def).toContain('"processedAt" IS NULL');
    });
  });

  describe('CHECK constraints', () => {
    it('refuses a zero or negative session rate', async () => {
      // `balance / rate` with rate 0 is Infinity — a call that can never be cut off in M10.
      expect(await constraintDef('Session_ratePaisePerMinute_positive')).toContain(
        '"ratePaisePerMinute" > 0',
      );
      expect(await constraintDef('MentorProfile_ratePaisePerMinute_positive')).toContain(
        '"ratePaisePerMinute" > 0',
      );
    });

    it('bounds the platform fee to real basis points', async () => {
      const def = await constraintDef('Session_platformFeeBps_bounds');
      expect(def).toContain('10000');
    });

    it('refuses an impossible timestamp ordering', async () => {
      // LiveKit's clock is not ours. A skewed webhook that would write an anchor before the
      // session existed fails here rather than producing a negative duration in M10.
      expect(await constraintDef('Session_timestamps_ordered')).not.toBeNull();
    });

    it('refuses a terminal session with no recorded reason', async () => {
      expect(await constraintDef('Session_terminal_has_reason')).not.toBeNull();
    });

    it('bounds a rating to whole stars 1..5', async () => {
      // The DTO checks this too, but the DTO is not what the nightly reconciler re-derives the
      // mentor's average from — this table is, and an out-of-range row would poison it silently.
      const def = await constraintDef('Review_rating_bounds');
      expect(def).toContain('rating');
      expect(def).toContain('5');
    });

    it('requires a reason on a hidden review', async () => {
      // Moderation with no recorded reason is indistinguishable from a bug that hid someone.
      expect(await constraintDef('Review_hidden_has_reason')).not.toBeNull();
    });

    it('keeps a queue entry internally consistent about whether it has left', async () => {
      // The reconciler decides what belongs in Redis purely from `status`, so "still waiting"
      // has to be unambiguous.
      expect(await constraintDef('QueueEntry_waiting_has_not_left')).not.toBeNull();
      expect(await constraintDef('QueueEntry_promoted_has_timestamp')).not.toBeNull();
    });
  });

  describe('the constraints actually fire', () => {
    it('rejects a session row whose status is terminal but has no reason', async () => {
      // Asserting the definition exists is not the same as asserting it bites. This is the
      // half that would survive someone marking the constraint NOT VALID.
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "Session"
             ("id","mode","status","userId","mentorProfileId","mentorUserId",
              "ratePaisePerMinute","platformFeeBps","updatedAt")
           VALUES ('invariant-probe','VOICE','COMPLETED','u','m','mu',100,3000,NOW())`,
        ),
      ).rejects.toThrow();
    });

    it('rejects a session row with a zero rate', async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "Session"
             ("id","mode","status","userId","mentorProfileId","mentorUserId",
              "ratePaisePerMinute","platformFeeBps","updatedAt")
           VALUES ('invariant-probe-2','VOICE','RINGING','u','m','mu',0,3000,NOW())`,
        ),
      ).rejects.toThrow();
    });
  });
});
