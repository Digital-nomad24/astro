-- CreateEnum
CREATE TYPE "AuthProvider" AS ENUM ('EMAIL_PASSWORD', 'GOOGLE', 'PHONE', 'OTHER');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "authProvider" "AuthProvider" NOT NULL DEFAULT 'OTHER';

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");
