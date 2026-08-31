import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';

import type { EnvVars } from '../../../../config/env.schema';
import { REDIS_CLIENT } from '../../../infra/redis/redis.tokens';

/**
 * Per-user send limiter: a fixed window of `INCR` + `EXPIRE`.
 *
 * Text sessions bill by wall-clock minute, not by message, so a flood is pure cost with no
 * revenue attached — every message is a row, a transaction and a cluster-wide fan-out. That
 * makes this an abuse control rather than a metering one.
 *
 * A fixed window rather than a sliding one on purpose: the failure mode of a fixed window is
 * that a user can send 2× the limit across a window boundary, which for chat is harmless. A
 * sliding window costs a sorted set per user and a trim on every message, which is more work
 * than the thing it is protecting.
 */
@Injectable()
export class ChatRateLimitService {
  private readonly logger = new Logger(ChatRateLimitService.name);
  private readonly limit: number;
  private readonly windowSeconds: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService<EnvVars, true>,
  ) {
    this.limit = config.get('CHAT_SEND_RATE_LIMIT', { infer: true });
    this.windowSeconds = config.get('CHAT_SEND_RATE_WINDOW_S', { infer: true });
  }

  /** True when the message may proceed. */
  async allow(userId: string, sessionId: string): Promise<boolean> {
    const key = `chat:rate:${sessionId}:${userId}`;

    try {
      // Pipelined: two round trips per message would be a real cost on the hot path.
      const [count] = (await this.redis
        .multi()
        .incr(key)
        .expire(key, this.windowSeconds, 'NX')
        .exec()) as [[Error | null, number], [Error | null, number]];

      return (count?.[1] ?? 0) <= this.limit;
    } catch (error) {
      // Fails OPEN. Redis being down must not stop two people mid-consultation from talking —
      // the cost of a brief unlimited window is far below the cost of a paid session going
      // silent. The same trade-off the identity cache makes.
      this.logger.warn(
        `Chat rate limit unavailable, allowing send: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return true;
    }
  }
}
