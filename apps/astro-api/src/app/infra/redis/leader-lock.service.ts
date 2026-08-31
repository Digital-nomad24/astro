import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';

import type { EnvVars } from '../../../config/env.schema';
import { REDIS_CLIENT } from './redis.tokens';

/**
 * Single-winner election for scheduled work.
 *
 * **Every `@Cron` in this application must go through this.** The reference repo's crons rely
 * on an undocumented `--max-instances=1` deployment flag for their single-firing guarantee;
 * this service exists because that guarantee is gone here — we deploy up to 20 instances, and
 * an unlocked billing sweeper across 20 instances is 20× the intended charge.
 *
 * The lock is an optimisation, not a correctness boundary. It stops redundant work; it does
 * not make the work safe. Correctness still comes from the database — unique constraints,
 * conditional updates — because a lock can expire mid-task under a slow query and Redis can
 * be flushed. Write every task so that two concurrent runs would still be correct, then use
 * this so they usually do not happen.
 */
@Injectable()
export class LeaderLockService {
  private readonly logger = new Logger(LeaderLockService.name);
  private readonly defaultTtlSeconds: number;

  /**
   * Compare-and-delete. Releasing with a plain DEL would let a task that overran its TTL
   * delete the lock a *different* instance has since acquired.
   */
  private static readonly RELEASE_SCRIPT = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    else
      return 0
    end
  `;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService<EnvVars, true>,
  ) {
    this.defaultTtlSeconds = config.get('LEADER_LOCK_TTL_S', { infer: true });
  }

  /**
   * Run `task` only if this instance wins the lock for `name`. Returns the task's result, or
   * `null` if another instance holds it.
   *
   * Set `ttlSeconds` above the task's realistic worst-case duration. Too short and two
   * instances overlap; too long and a crashed holder blocks the job for that whole window.
   */
  async withLock<T>(name: string, task: () => Promise<T>, ttlSeconds?: number): Promise<T | null> {
    const key = `lock:${name}`;
    const token = randomUUID();
    const ttl = ttlSeconds ?? this.defaultTtlSeconds;

    const acquired = await this.redis.set(key, token, 'EX', ttl, 'NX');
    if (acquired !== 'OK') return null;

    try {
      return await task();
    } finally {
      try {
        await this.redis.eval(LeaderLockService.RELEASE_SCRIPT, 1, key, token);
      } catch (err) {
        // Losing the release is survivable — the TTL reclaims it. Losing the task result is not.
        this.logger.warn(
          `Failed to release lock "${name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
