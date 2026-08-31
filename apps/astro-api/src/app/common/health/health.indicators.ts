import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import type { Redis } from 'ioredis';

import { PrismaService } from 'prisma/prisma.service';
import { REDIS_CLIENT } from '../../infra/redis/redis.tokens';

/**
 * Readiness indicators. Each catches its own failure and reports `down` rather than throwing,
 * so one unreachable dependency produces a precise readiness body instead of a 500 that says
 * nothing about which dependency broke.
 */
@Injectable()
export class HealthIndicators {
  constructor(
    private readonly health: HealthIndicatorService,
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async db(): Promise<HealthIndicatorResult> {
    const indicator = this.health.check('database');
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return indicator.up();
    } catch (err) {
      return indicator.down({ message: err instanceof Error ? err.message : 'unreachable' });
    }
  }

  async redisPing(): Promise<HealthIndicatorResult> {
    const indicator = this.health.check('redis');
    try {
      // Reuses the shared client rather than constructing one per probe — the reference repo
      // built a fresh client on every readiness call, which is a connection per 10 seconds.
      // Widened to `string`: ioredis types `ping()` as returning the literal 'PONG', which
      // would make the failure branch unreachable at the type level but not at runtime.
      const pong: string = await this.redis.ping();
      return pong === 'PONG'
        ? indicator.up()
        : indicator.down({ message: `unexpected ping response: ${pong}` });
    } catch (err) {
      return indicator.down({ message: err instanceof Error ? err.message : 'unreachable' });
    }
  }
}
