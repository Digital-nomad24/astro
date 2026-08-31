import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS_CLIENT } from '../../../infra/redis/redis.tokens';
import type { IPresenceRecord, IPresenceRepo } from '../../domain/repos/presence.repo.interface';

/**
 * Redis is the live truth for presence, in two structures that answer different questions:
 *
 *   presence:mentor:<id>   STRING with TTL  — "is this mentor online, and how?"
 *   presence:heartbeats    ZSET by ms       — "who has stopped heartbeating?"
 *
 * The TTL key is self-healing: an instance that dies mid-session cannot write OFFLINE, but its
 * mentors' keys expire on their own within the TTL. The ZSET exists because an expired key is
 * simply gone — nothing would ever tell the fleet to publish the OFFLINE transition, so the
 * sweeper needs an enumerable index of who is supposed to be alive.
 */
@Injectable()
export class PresenceRedisRepo implements IPresenceRepo {
  private readonly logger = new Logger(PresenceRedisRepo.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async set(record: IPresenceRecord, ttlSeconds: number): Promise<void> {
    await this.redis
      .multi()
      .set(key(record.mentorProfileId), JSON.stringify(record), 'EX', ttlSeconds)
      .zadd(HEARTBEATS_KEY, record.updatedAtMs, record.mentorProfileId)
      .exec();
  }

  /**
   * `EXPIRE` returns 0 when the key does not exist, which is how a heartbeat from a mentor
   * whose record already lapsed is detected — the caller then re-announces rather than
   * silently heartbeating a record nobody can see.
   */
  async touch(mentorProfileId: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now();
    const results = await this.redis
      .multi()
      .expire(key(mentorProfileId), ttlSeconds)
      .zadd(HEARTBEATS_KEY, now, mentorProfileId)
      .exec();

    const refreshed = results?.[0]?.[1];
    return refreshed === 1;
  }

  async get(mentorProfileId: string): Promise<IPresenceRecord | null> {
    const raw = await this.redis.get(key(mentorProfileId));
    return this.parse(raw);
  }

  async getMany(mentorProfileIds: readonly string[]): Promise<IPresenceRecord[]> {
    if (mentorProfileIds.length === 0) return [];

    // MGET takes rest args, not an array.
    const raws = await this.redis.mget(...mentorProfileIds.map(key));
    return raws
      .map((raw) => this.parse(raw))
      .filter((record): record is IPresenceRecord => record !== null);
  }

  async clear(mentorProfileId: string): Promise<void> {
    await this.redis.multi().del(key(mentorProfileId)).zrem(HEARTBEATS_KEY, mentorProfileId).exec();
  }

  async findStale(olderThanMs: number): Promise<string[]> {
    // A range query, not a scan — the whole reason the score is a timestamp.
    return this.redis.zrangebyscore(HEARTBEATS_KEY, '-inf', olderThanMs);
  }

  private parse(raw: string | null): IPresenceRecord | null {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as IPresenceRecord;
    } catch (err) {
      // A corrupt value must not take down a browse request; treat it as offline.
      this.logger.warn(`Discarding unparseable presence record: ${String(err)}`);
      return null;
    }
  }
}

const HEARTBEATS_KEY = 'presence:heartbeats';
const key = (mentorProfileId: string): string => `presence:mentor:${mentorProfileId}`;
