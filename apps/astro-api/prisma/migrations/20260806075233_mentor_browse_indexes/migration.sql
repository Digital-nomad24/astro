-- DropIndex
DROP INDEX "MentorProfile_approvalStatus_categoryId_presenceState_ratin_idx";

-- DropIndex
DROP INDEX "MentorProfile_approvalStatus_categoryId_ratePaisePerMinute_idx";

-- DropIndex
DROP INDEX "MentorProfile_approvalStatus_createdAt_idx";

-- DropIndex
DROP INDEX "MentorProfile_approvalStatus_presenceState_ratingAvg_idx";

-- CreateIndex
CREATE INDEX "MentorProfile_approvalStatus_categoryId_ratingAvg_id_idx" ON "MentorProfile"("approvalStatus", "categoryId", "ratingAvg" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "MentorProfile_approvalStatus_ratingAvg_id_idx" ON "MentorProfile"("approvalStatus", "ratingAvg" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "MentorProfile_approvalStatus_categoryId_ratePaisePerMinute__idx" ON "MentorProfile"("approvalStatus", "categoryId", "ratePaisePerMinute", "id");

-- CreateIndex
CREATE INDEX "MentorProfile_approvalStatus_ratePaisePerMinute_id_idx" ON "MentorProfile"("approvalStatus", "ratePaisePerMinute", "id");

-- CreateIndex
CREATE INDEX "MentorProfile_approvalStatus_createdAt_id_idx" ON "MentorProfile"("approvalStatus", "createdAt", "id");
