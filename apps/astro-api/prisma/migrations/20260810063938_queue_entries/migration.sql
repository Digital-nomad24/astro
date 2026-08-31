-- CreateEnum
CREATE TYPE "QueueEntryStatus" AS ENUM ('WAITING', 'PROMOTED', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "QueueEntry" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "mentorProfileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mode" "SessionMode" NOT NULL,
    "status" "QueueEntryStatus" NOT NULL DEFAULT 'WAITING',
    "enqueuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedAt" TIMESTAMP(3),
    "promotedAt" TIMESTAMP(3),
    "leftAt" TIMESTAMP(3),
    "leaveReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QueueEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QueueEntry_sessionId_key" ON "QueueEntry"("sessionId");

-- CreateIndex
CREATE INDEX "QueueEntry_mentorProfileId_status_enqueuedAt_idx" ON "QueueEntry"("mentorProfileId", "status", "enqueuedAt");

-- CreateIndex
CREATE INDEX "QueueEntry_status_enqueuedAt_idx" ON "QueueEntry"("status", "enqueuedAt");

-- CreateIndex
CREATE INDEX "QueueEntry_userId_status_idx" ON "QueueEntry"("userId", "status");

-- AddForeignKey
ALTER TABLE "QueueEntry" ADD CONSTRAINT "QueueEntry_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueEntry" ADD CONSTRAINT "QueueEntry_mentorProfileId_fkey" FOREIGN KEY ("mentorProfileId") REFERENCES "MentorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written. Prisma expresses neither partial indexes nor CHECK constraints;
-- `test/schema-invariants.e2e-spec.ts` asserts each of these exists, because a
-- later `migrate dev` will propose dropping an index it never declared.
-- ---------------------------------------------------------------------------

-- A user occupies one mentor at a time, INCLUDING while merely waiting.
--
-- The M4 version of this index covered only RINGING and ACTIVE. That was right when queueing
-- did not exist; it is wrong now. Without QUEUED, one person could hold a place in every
-- mentor's line and be promoted into several calls at once — and each of those promotions
-- would be individually valid, which is exactly the kind of race no amount of application
-- logic catches reliably.
--
-- Deliberately NOT mirrored on the mentor index: many users queue for one mentor, and that is
-- the entire point. `session_one_inflight_per_mentor` stays scoped to RINGING and ACTIVE, and
-- it is what makes exactly one promotion win when two instances dispatch at once.
DROP INDEX "session_one_inflight_per_user";
CREATE UNIQUE INDEX "session_one_inflight_per_user"
  ON "Session" ("userId")
  WHERE "status" IN ('QUEUED', 'RINGING', 'ACTIVE');

-- The same guarantee, restated on the queue's own table. Redundant with the index above by
-- construction — one WAITING entry per QUEUED session, one QUEUED session per user — and kept
-- because the reconciler rebuilds Redis from THIS table. A duplicate here would put one user
-- in the sorted set twice, and they would be promoted twice.
CREATE UNIQUE INDEX "queue_entry_one_waiting_per_user"
  ON "QueueEntry" ("userId")
  WHERE "status" = 'WAITING';

-- A waiting entry has not left; a departed one has. Makes "still waiting" unambiguous for the
-- reconciler, which decides what belongs in Redis purely from this table.
ALTER TABLE "QueueEntry"
  ADD CONSTRAINT "QueueEntry_waiting_has_not_left"
  CHECK (
    ("status" = 'WAITING' AND "leftAt" IS NULL AND "leaveReason" IS NULL)
    OR ("status" <> 'WAITING' AND "leftAt" IS NOT NULL AND "leaveReason" IS NOT NULL)
  );

-- Only a promoted entry has a promotion time.
ALTER TABLE "QueueEntry"
  ADD CONSTRAINT "QueueEntry_promoted_has_timestamp"
  CHECK (("status" = 'PROMOTED') = ("promotedAt" IS NOT NULL));
