-- CreateEnum
CREATE TYPE "SessionMode" AS ENUM ('VOICE', 'TEXT', 'VIDEO');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('QUEUED', 'RINGING', 'ACTIVE', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "SessionEndReason" AS ENUM ('COMPLETED_BY_USER', 'COMPLETED_BY_MENTOR', 'BALANCE_EXHAUSTED', 'MAX_DURATION_REACHED', 'IDLE_TIMEOUT', 'RING_TIMEOUT', 'DECLINED', 'CANCELLED_BY_USER', 'MENTOR_OFFLINE', 'QUEUE_EXPIRED', 'MEDIA_FAILURE', 'ADMIN_TERMINATED');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "mode" "SessionMode" NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'RINGING',
    "userId" TEXT NOT NULL,
    "mentorProfileId" TEXT NOT NULL,
    "mentorUserId" TEXT NOT NULL,
    "ratePaisePerMinute" INTEGER NOT NULL,
    "platformFeeBps" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ringingAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "billingAnchorAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endReason" "SessionEndReason",
    "livekitRoomName" TEXT,
    "livekitRoomSid" TEXT,
    "participantJoinCount" INTEGER NOT NULL DEFAULT 0,
    "connectedIdentities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "recordingConsentUserAt" TIMESTAMP(3),
    "recordingConsentMentorAt" TIMESTAMP(3),
    "egressId" TEXT,
    "summaryIneligibleReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "roomName" TEXT,
    "participantIdentity" TEXT,
    "sessionId" TEXT,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Session_livekitRoomName_key" ON "Session"("livekitRoomName");

-- CreateIndex
CREATE INDEX "Session_userId_createdAt_idx" ON "Session"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Session_mentorProfileId_createdAt_idx" ON "Session"("mentorProfileId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Session_status_ringingAt_idx" ON "Session"("status", "ringingAt");

-- CreateIndex
CREATE INDEX "Session_status_billingAnchorAt_idx" ON "Session"("status", "billingAnchorAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_sessionId_idx" ON "WebhookEvent"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_source_eventId_key" ON "WebhookEvent"("source", "eventId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_mentorProfileId_fkey" FOREIGN KEY ("mentorProfileId") REFERENCES "MentorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Everything below is hand-written: Prisma cannot express partial indexes or
-- CHECK constraints, and these are the constraints the correctness of the
-- session lifecycle actually rests on. Re-running `prisma migrate dev` will
-- NOT regenerate them, so they must be preserved when this file is edited.
-- ---------------------------------------------------------------------------

-- A user may be in at most one live session, and a mentor may take at most one.
--
-- This is the mutual exclusion, not the `findFirst` that precedes it in the use case.
-- That check is a fast, friendly 409; this is the guarantee. Two requests that pass the
-- check concurrently both reach the INSERT and exactly one survives — the loser gets
-- 23505 and is mapped to the same 409, so the race is invisible to the caller.
--
-- Scoped to the in-flight statuses only, so a user's completed history does not collide.
-- The predicate must stay byte-identical to INFLIGHT_SESSION_STATUSES in
-- libs/astro-service/shared/contracts/src/lib/enums.ts.
CREATE UNIQUE INDEX "session_one_inflight_per_user"
  ON "Session" ("userId")
  WHERE "status" IN ('RINGING', 'ACTIVE');

CREATE UNIQUE INDEX "session_one_inflight_per_mentor"
  ON "Session" ("mentorProfileId")
  WHERE "status" IN ('RINGING', 'ACTIVE');

-- A zero or negative rate makes `balance / rate` infinite in M10 — a call that can never be
-- cut off, billing against a wallet that never empties. Guarded at the mentor profile too;
-- duplicated here because Session freezes its own copy and a bad copy is what would actually
-- reach the meter.
ALTER TABLE "Session"
  ADD CONSTRAINT "Session_ratePaisePerMinute_positive"
  CHECK ("ratePaisePerMinute" > 0);

ALTER TABLE "Session"
  ADD CONSTRAINT "Session_platformFeeBps_bounds"
  CHECK ("platformFeeBps" >= 0 AND "platformFeeBps" <= 10000);

-- A session cannot start metering before it was created, and cannot end before it started.
-- LiveKit's clock is not ours; a skewed webhook that would write an impossible ordering
-- fails loudly here instead of producing a negative billed duration in M10.
ALTER TABLE "Session"
  ADD CONSTRAINT "Session_timestamps_ordered"
  CHECK (
    ("billingAnchorAt" IS NULL OR "billingAnchorAt" >= "createdAt")
    AND ("endedAt" IS NULL OR "endedAt" >= "createdAt")
  );

-- Every terminal session carries a reason, and no live one does. A session that ended with
-- no recorded reason has already destroyed the evidence needed to explain it.
ALTER TABLE "Session"
  ADD CONSTRAINT "Session_terminal_has_reason"
  CHECK (
    ("status" IN ('COMPLETED', 'CANCELLED', 'FAILED') AND "endReason" IS NOT NULL AND "endedAt" IS NOT NULL)
    OR ("status" NOT IN ('COMPLETED', 'CANCELLED', 'FAILED') AND "endReason" IS NULL AND "endedAt" IS NULL)
  );

-- The inbox sweep only ever looks at unprocessed rows. Partial, so the index stays the size
-- of the backlog rather than the size of history — this table only grows.
CREATE INDEX "webhook_event_unprocessed"
  ON "WebhookEvent" ("receivedAt")
  WHERE "processedAt" IS NULL;
