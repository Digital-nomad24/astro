import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

import type { EnvVars } from '../../../config/env.schema';
import { LeaderLockService } from './leader-lock.service';
import { REDIS_CLIENT } from './redis.tokens';

/**
 * One ioredis connection pool for everything: presence keys, the queue ZSETs and their Lua
 * scripts, rate limiters, leader locks, and (duplicated) the Socket.IO adapter's pub/sub pair.
 *
 * The reference repo split this — `@upstash/redis` over REST for data, `ioredis` over TCP for
 * the adapter. That does not work here: REST cannot do pub/sub, cannot run EVALSHA (which the
 * queue dispatcher needs in order to be atomic), and pays an HTTP round trip per command on
 * the dispatch path.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>): Redis => {
        const logger = new Logger('RedisClient');
        // `rediss://` enables TLS automatically.
        const client = new Redis(config.get('REDIS_URL', { infer: true }), {
          // Fail commands fast rather than queueing them forever behind a dead connection —
          // callers on the request path should see an error, not hang.
          maxRetriesPerRequest: 3,
          enableReadyCheck: true,
        });
        client.on('error', (err) => logger.error(`Redis client error: ${err.message}`));
        client.on('reconnecting', () => logger.warn('Redis client reconnecting'));
        return client;
      },
    },
    LeaderLockService,
  ],
  exports: [REDIS_CLIENT, LeaderLockService],
})
export class RedisModule implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisModule.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Nest cannot dispose an arbitrary factory value on its own, so the module does it. Runs on
   * SIGTERM because `main.ts` calls `enableShutdownHooks()`. The adapter's duplicated pub/sub
   * pair is closed separately by `RedisIoAdapter.close()`.
   */
  async onApplicationShutdown(): Promise<void> {
    try {
      await this.redis.quit();
    } catch (err) {
      // A failed graceful quit must not hold up shutdown; Cloud Run will kill us anyway.
      this.logger.warn(`Redis quit failed: ${err instanceof Error ? err.message : String(err)}`);
      this.redis.disconnect();
    }
  }
}
