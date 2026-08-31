import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS_CLIENT } from '../../../infra/redis/redis.tokens';
import type { IQueueRedisRepo } from '../../domain/repos/queue.repos';

const queueKey = (mentorProfileId: string): string => `queue:mentor:${mentorProfileId}`;
const dispatchLockKey = (mentorProfileId: string): string => `queue:dispatch:${mentorProfileId}`;
const offlineKey = (mentorProfileId: string): string => `queue:offline:${mentorProfileId}`;

/**
 * Takes the dispatch lock and pops the head in one atomic step.
 *
 * Splitting these would open the exact window the lock exists to close: instance A pops,
 * instance B takes the lock before A can, and now two instances each hold a different waiting
 * user and both believe they are the dispatcher.
 *
 * Returns `{member, score}` or nil. Releasing the lock is deliberately NOT part of this
 * script — it must outlive the pop and cover the promotion that follows.
 */
const CLAIM_NEXT = `
  if redis.call('SET', KEYS[2], ARGV[1], 'NX', 'EX', ARGV[2]) then
    local popped = redis.call('ZPOPMIN', KEYS[1], 1)
    if #popped == 0 then
      -- Empty queue: give the lock straight back rather than blocking the next dispatch for
      -- a whole TTL over a queue that had nothing in it.
      redis.call('DEL', KEYS[2])
      return nil
    end
    return { popped[1], popped[2] }
  end
  return nil
`;

/** Compare-and-delete: a dispatch that overran its TTL must not free someone else's lock. */
const RELEASE_LOCK = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

/**
 * Replaces a mentor's queue in one atomic step.
 *
 * `DEL` then `ZADD` as separate commands would leave a window in which the queue is empty and
 * a concurrent dispatch concludes there is nobody to promote — the reconciler would cause the
 * very starvation it exists to repair.
 */
const REBUILD = `
  redis.call('DEL', KEYS[1])
  if #ARGV > 0 then
    redis.call('ZADD', KEYS[1], unpack(ARGV))
  end
  return redis.call('ZCARD', KEYS[1])
`;

@Injectable()
export class QueueRedisRepo implements IQueueRedisRepo {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * `ZADD` is idempotent on the member, so a retried enqueue does not create a second place in
   * line. `GT` is deliberately absent — a re-add must be able to restore an *earlier* score,
   * which is precisely what `reinstate` needs.
   */
  async enqueue(mentorProfileId: string, sessionId: string, scoreMs: number): Promise<number> {
    await this.redis.zadd(queueKey(mentorProfileId), scoreMs, sessionId);
    return (await this.positionOf(mentorProfileId, sessionId)) ?? 1;
  }

  async reinstate(mentorProfileId: string, sessionId: string, scoreMs: number): Promise<void> {
    // At the ORIGINAL score. Re-inserting at `now` would send a user who lost a race they
    // never knew about to the back of the line.
    await this.redis.zadd(queueKey(mentorProfileId), scoreMs, sessionId);
  }

  async remove(mentorProfileId: string, sessionId: string): Promise<boolean> {
    return (await this.redis.zrem(queueKey(mentorProfileId), sessionId)) > 0;
  }

  async positionOf(mentorProfileId: string, sessionId: string): Promise<number | null> {
    const rank = await this.redis.zrank(queueKey(mentorProfileId), sessionId);
    return rank === null ? null : rank + 1;
  }

  depth(mentorProfileId: string): Promise<number> {
    return this.redis.zcard(queueKey(mentorProfileId));
  }

  async members(mentorProfileId: string): Promise<{ sessionId: string; scoreMs: number }[]> {
    const flat = await this.redis.zrange(queueKey(mentorProfileId), 0, -1, 'WITHSCORES');
    const out: { sessionId: string; scoreMs: number }[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      out.push({ sessionId: flat[i], scoreMs: Number(flat[i + 1]) });
    }
    return out;
  }

  async claimNext(
    mentorProfileId: string,
    lockToken: string,
    lockTtlSeconds: number,
  ): Promise<{ sessionId: string; scoreMs: number } | null> {
    const result = (await this.redis.eval(
      CLAIM_NEXT,
      2,
      queueKey(mentorProfileId),
      dispatchLockKey(mentorProfileId),
      lockToken,
      String(lockTtlSeconds),
    )) as [string, string] | null;

    if (!result) return null;
    return { sessionId: result[0], scoreMs: Number(result[1]) };
  }

  async releaseDispatchLock(mentorProfileId: string, lockToken: string): Promise<void> {
    await this.redis.eval(RELEASE_LOCK, 1, dispatchLockKey(mentorProfileId), lockToken);
  }

  async rebuild(
    mentorProfileId: string,
    entries: readonly { sessionId: string; scoreMs: number }[],
  ): Promise<void> {
    const args = entries.flatMap((entry) => [String(entry.scoreMs), entry.sessionId]);
    await this.redis.eval(REBUILD, 1, queueKey(mentorProfileId), ...args);
  }

  /**
   * No TTL on this key. The whole point is to measure how long a mentor has been gone, and a
   * key that expired mid-hold would silently restart the clock and keep a dissolved queue
   * waiting forever.
   */
  async setMentorOfflineSince(mentorProfileId: string, at: Date | null): Promise<void> {
    if (at === null) {
      await this.redis.del(offlineKey(mentorProfileId));
      return;
    }
    // NX: the FIRST moment they went offline is the one that matters. A repeated OFFLINE
    // broadcast must not push the deadline back.
    await this.redis.set(offlineKey(mentorProfileId), String(at.getTime()), 'NX');
  }

  async getMentorOfflineSince(mentorProfileId: string): Promise<Date | null> {
    const raw = await this.redis.get(offlineKey(mentorProfileId));
    if (!raw) return null;
    const ms = Number(raw);
    return Number.isFinite(ms) ? new Date(ms) : null;
  }
}
