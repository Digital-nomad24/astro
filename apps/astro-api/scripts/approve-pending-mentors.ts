import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';
import Redis from 'ioredis';
import { Pool } from 'pg';

import { PrismaClient } from '../prisma/src/generated/prisma/client';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  const redis = new Redis(process.env.REDIS_URL!);

  try {
    const pending = await prisma.mentorProfile.findMany({
      where: { approvalStatus: 'PENDING' },
      include: {
        user: { select: { id: true, email: true, displayName: true, role: true, firebaseUid: true } },
      },
    });

    if (pending.length === 0) {
      console.log('No pending mentor applications.');
      return;
    }

    for (const profile of pending) {
      await prisma.user.update({
        where: { id: profile.userId },
        data: { role: 'MENTOR' },
      });

      await prisma.mentorProfile.update({
        where: { id: profile.id },
        data: {
          approvalStatus: 'APPROVED',
          approvalNote: null,
          approvedAt: new Date(),
        },
      });

      await redis.del(`identity:uid:${profile.user.firebaseUid}`);

      console.log(
        `Approved: ${profile.displayName} (${profile.user.email ?? profile.user.id})`,
      );
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
    await redis.quit();
  }
}

void main();
