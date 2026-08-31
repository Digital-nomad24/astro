import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';
import Redis from 'ioredis';
import { Pool } from 'pg';

import { PrismaClient } from '../prisma/src/generated/prisma/client';

async function main(): Promise<void> {
  const email = process.argv[2];
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  const redis = new Redis(process.env.REDIS_URL!);

  try {
    const user = email
      ? await prisma.user.findFirst({ where: { email } })
      : await prisma.user.findFirst({
          where: { mentorProfile: { approvalStatus: 'APPROVED' } },
          orderBy: { updatedAt: 'desc' },
        });

    if (!user) {
      console.log('User not found.');
      return;
    }

    await redis.del(`identity:uid:${user.firebaseUid}`);
    console.log(`Invalidated identity cache for ${user.email ?? user.id} (role: ${user.role})`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
    await redis.quit();
  }
}

void main();
