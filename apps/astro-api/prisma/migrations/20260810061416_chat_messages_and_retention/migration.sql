-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "lastMessageAt" TIMESTAMP(3),
ADD COLUMN     "messageCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "messagesPurgedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "clientMsgId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatMessage_sessionId_createdAt_id_idx" ON "ChatMessage"("sessionId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_sessionId_clientMsgId_key" ON "ChatMessage"("sessionId", "clientMsgId");

-- CreateIndex
CREATE INDEX "Session_status_mode_lastMessageAt_idx" ON "Session"("status", "mode", "lastMessageAt");

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written: Prisma can express neither partial indexes nor CHECK
-- constraints. `test/schema-invariants.e2e-spec.ts` asserts each of these
-- exists, because a later `migrate dev` will propose dropping an index it
-- never declared. Preserve them when editing this file.
-- ---------------------------------------------------------------------------

-- The retention sweep only ever looks at transcripts that are still retained, and only at
-- text sessions. Partial on both, so the index stays the size of the *pending* work rather
-- than of session history — which grows forever while this backlog does not.
CREATE INDEX "session_transcript_pending_purge"
  ON "Session" ("endedAt")
  WHERE "messagesPurgedAt" IS NULL AND "mode" = 'TEXT' AND "endedAt" IS NOT NULL;

-- A message body is never empty. An empty message is not a message a user sent; it is a
-- client bug, and one that would reach the M8 summariser as noise.
ALTER TABLE "ChatMessage"
  ADD CONSTRAINT "ChatMessage_body_not_empty"
  CHECK (length(btrim("body")) > 0);

-- A purged transcript cannot have been purged before the session ended, and a session whose
-- transcript is gone must have ended. This is what makes "purged" unambiguous later: a null
-- means retained, never "we are not sure".
ALTER TABLE "Session"
  ADD CONSTRAINT "Session_purge_after_end"
  CHECK ("messagesPurgedAt" IS NULL OR ("endedAt" IS NOT NULL AND "messagesPurgedAt" >= "endedAt"));

-- The count survives the purge and must stay meaningful.
ALTER TABLE "Session"
  ADD CONSTRAINT "Session_messageCount_non_negative"
  CHECK ("messageCount" >= 0);
