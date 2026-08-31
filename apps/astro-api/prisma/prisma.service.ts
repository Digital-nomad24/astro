import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

import type { EnvVars } from '../src/config/env.schema';
import { PrismaClient } from './src/generated/prisma/client';

/**
 * Uses the `pg` driver adapter with an explicitly owned `Pool`, which is what makes Prisma's
 * interactive transactions (`$transaction(async tx => ...)`) behave — the billing ledger's
 * atomicity depends on them, so `DATABASE_URL` must be a direct connection, never a
 * transaction-mode pooler. `env.schema.ts` refuses to boot against one.
 *
 * No `onModuleInit`/`$connect`: the adapter connects lazily and the readiness probe's
 * `SELECT 1` is what actually gates traffic.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly pool: Pool;

  constructor(config: ConfigService<EnvVars, true>) {
    const pool = new Pool({ connectionString: config.get('DATABASE_URL', { infer: true }) });

    super({ adapter: new PrismaPg(pool), log: ['warn', 'error'] });

    this.pool = pool;
  }

  /** Runs on SIGTERM because `main.ts` enables shutdown hooks. */
  async onModuleDestroy(): Promise<void> {
    try {
      await this.$disconnect();
      await this.pool.end();
    } catch (err) {
      this.logger.warn(
        `Prisma shutdown failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
