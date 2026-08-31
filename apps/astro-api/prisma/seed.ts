import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

import { PrismaClient } from './src/generated/prisma/client';

/**
 * Idempotent seed — safe to run repeatedly against the same database.
 *
 * Seeds consultation categories and optionally promotes real accounts to ADMIN.
 * Does not insert synthetic mentors; real profiles come from sign-in and apply flows.
 */

const CATEGORIES = [
  { slug: 'astrology', name: 'Astrology', description: 'Vedic and Western chart readings.', sortOrder: 10 },
  { slug: 'tarot', name: 'Tarot', description: 'Card readings and intuitive guidance.', sortOrder: 20 },
  { slug: 'numerology', name: 'Numerology', description: 'Numbers, names and life-path analysis.', sortOrder: 30 },
  { slug: 'career-coaching', name: 'Career Coaching', description: 'Direction, transitions and interviews.', sortOrder: 40 },
  { slug: 'relationship-counselling', name: 'Relationship Counselling', description: 'Partnership and family guidance.', sortOrder: 50 },
];

async function removeLegacySeedMentors(prisma: PrismaClient): Promise<number> {
  const seedUsers = await prisma.user.findMany({
    where: { firebaseUid: { startsWith: 'seed-mentor-' } },
    select: { id: true },
  });
  if (seedUsers.length === 0) return 0;

  await prisma.mentorProfile.deleteMany({
    where: { userId: { in: seedUsers.map((u) => u.id) } },
  });
  const { count } = await prisma.user.deleteMany({
    where: { id: { in: seedUsers.map((u) => u.id) } },
  });
  return count;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required to seed.');

  const pool = new Pool({ connectionString });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    const removed = await removeLegacySeedMentors(prisma);
    if (removed > 0) {
      console.log(`seed: removed ${removed} legacy synthetic mentor account(s).`);
    }

    for (const category of CATEGORIES) {
      await prisma.mentorCategory.upsert({
        where: { slug: category.slug },
        update: { name: category.name, description: category.description, sortOrder: category.sortOrder },
        create: { ...category, isActive: true },
      });
    }
    const categories = await prisma.mentorCategory.findMany({ orderBy: { sortOrder: 'asc' } });
    console.log(`seed: ${categories.length} categories ready.`);

    const emails = (process.env.ADMIN_BOOTSTRAP_EMAILS ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean);

    if (emails.length === 0) {
      console.log('seed: ADMIN_BOOTSTRAP_EMAILS is empty — no admins promoted.');
      return;
    }

    const { count } = await prisma.user.updateMany({
      where: { email: { in: emails }, role: { not: 'ADMIN' } },
      data: { role: 'ADMIN' },
    });
    const present = await prisma.user.count({ where: { email: { in: emails } } });

    console.log(`seed: promoted ${count} user(s) to ADMIN.`);
    if (present < emails.length) {
      console.log(
        `seed: ${emails.length - present} listed email(s) have no User row yet — sign in once, then re-run.`,
      );
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
