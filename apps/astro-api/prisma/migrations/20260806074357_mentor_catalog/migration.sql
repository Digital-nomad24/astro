-- CreateEnum
CREATE TYPE "MentorApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "PresenceState" AS ENUM ('OFFLINE', 'ONLINE', 'BUSY');

-- CreateTable
CREATE TABLE "MentorCategory" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "iconUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MentorCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MentorProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "headline" TEXT,
    "bio" TEXT,
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "experienceYears" INTEGER NOT NULL DEFAULT 0,
    "ratePaisePerMinute" INTEGER NOT NULL,
    "approvalStatus" "MentorApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "approvalNote" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedByUserId" TEXT,
    "presenceState" "PresenceState" NOT NULL DEFAULT 'OFFLINE',
    "presenceUpdatedAt" TIMESTAMP(3),
    "acceptingNewCalls" BOOLEAN NOT NULL DEFAULT true,
    "queueDepth" INTEGER NOT NULL DEFAULT 0,
    "ratingSum" INTEGER NOT NULL DEFAULT 0,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "ratingAvg" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalSessions" INTEGER NOT NULL DEFAULT 0,
    "totalBilledSeconds" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MentorProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MentorCategory_slug_key" ON "MentorCategory"("slug");

-- CreateIndex
CREATE INDEX "MentorCategory_isActive_sortOrder_idx" ON "MentorCategory"("isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "MentorProfile_userId_key" ON "MentorProfile"("userId");

-- CreateIndex
CREATE INDEX "MentorProfile_approvalStatus_categoryId_presenceState_ratin_idx" ON "MentorProfile"("approvalStatus", "categoryId", "presenceState", "ratingAvg" DESC);

-- CreateIndex
CREATE INDEX "MentorProfile_approvalStatus_presenceState_ratingAvg_idx" ON "MentorProfile"("approvalStatus", "presenceState", "ratingAvg" DESC);

-- CreateIndex
CREATE INDEX "MentorProfile_approvalStatus_categoryId_ratePaisePerMinute_idx" ON "MentorProfile"("approvalStatus", "categoryId", "ratePaisePerMinute");

-- CreateIndex
CREATE INDEX "MentorProfile_approvalStatus_createdAt_idx" ON "MentorProfile"("approvalStatus", "createdAt");

-- AddForeignKey
ALTER TABLE "MentorProfile" ADD CONSTRAINT "MentorProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorProfile" ADD CONSTRAINT "MentorProfile_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "MentorCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-added: Prisma has no schema syntax for CHECK constraints.
--
-- A zero or negative rate makes `balance / rate` infinite, i.e. a session with no affordable
-- duration that can never be cut off for running out of money. DTO validation already rejects
-- it, but this is the money path — the invariant belongs where it cannot be bypassed by a
-- migration, a seed, an admin tool, or a psql session.
ALTER TABLE "MentorProfile"
  ADD CONSTRAINT "MentorProfile_ratePaisePerMinute_positive"
  CHECK ("ratePaisePerMinute" > 0);

-- Ratings are bounded by construction elsewhere; this stops a bad aggregate write from
-- producing a catalogue sorted by an impossible score.
ALTER TABLE "MentorProfile"
  ADD CONSTRAINT "MentorProfile_rating_bounds"
  CHECK ("ratingCount" >= 0 AND "ratingSum" >= 0 AND "ratingAvg" >= 0 AND "ratingAvg" <= 5);
