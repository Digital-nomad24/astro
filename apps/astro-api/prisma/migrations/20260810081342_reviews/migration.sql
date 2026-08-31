-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "mentorProfileId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "authorDisplayName" TEXT,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "hiddenReason" TEXT,
    "hiddenByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Review_sessionId_key" ON "Review"("sessionId");

-- CreateIndex
CREATE INDEX "Review_mentorProfileId_isHidden_createdAt_id_idx" ON "Review"("mentorProfileId", "isHidden", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Review_authorUserId_createdAt_idx" ON "Review"("authorUserId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_mentorProfileId_fkey" FOREIGN KEY ("mentorProfileId") REFERENCES "MentorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written; asserted by `test/schema-invariants.e2e-spec.ts`.
-- ---------------------------------------------------------------------------

-- Whole stars, 1 through 5. The DTO checks this too, but the DTO is not what the nightly
-- reconciler recomputes the mentor's average from — this table is, and an out-of-range row
-- would poison the aggregate silently.
ALTER TABLE "Review"
  ADD CONSTRAINT "Review_rating_bounds"
  CHECK ("rating" >= 1 AND "rating" <= 5);

-- A hidden review says why it is hidden. Moderation with no recorded reason is indistinguishable
-- from a bug that hid someone's review.
ALTER TABLE "Review"
  ADD CONSTRAINT "Review_hidden_has_reason"
  CHECK ("isHidden" = false OR "hiddenReason" IS NOT NULL);
