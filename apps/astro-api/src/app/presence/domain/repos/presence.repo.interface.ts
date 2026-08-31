import type { PresenceState } from '@astro/contracts';

/** The live presence record, as held in Redis. */
export interface IPresenceRecord {
  readonly mentorProfileId: string;
  readonly categorySlug: string;
  readonly state: Exclude<PresenceState, 'OFFLINE'>;
  readonly acceptingNewCalls: boolean;
  readonly queueDepth: number;
  readonly ratePaisePerMinute: number;
  readonly updatedAtMs: number;
}

export interface IPresenceRepo {
  /**
   * Write the record and refresh its TTL. Absence of the key IS offline — there is no
   * "OFFLINE" record, because a crashed instance cannot write one.
   */
  set(record: IPresenceRecord, ttlSeconds: number): Promise<void>;
  /** Refresh only the TTL and the heartbeat score. Returns false if the record has expired. */
  touch(mentorProfileId: string, ttlSeconds: number): Promise<boolean>;
  get(mentorProfileId: string): Promise<IPresenceRecord | null>;
  getMany(mentorProfileIds: readonly string[]): Promise<IPresenceRecord[]>;
  clear(mentorProfileId: string): Promise<void>;
  /**
   * Mentors whose last heartbeat is older than the cutoff. The TTL key alone cannot answer
   * this — an expired key is simply gone, so nothing would ever tell us to publish the
   * transition to OFFLINE. That is what the heartbeat index is for.
   */
  findStale(olderThanMs: number): Promise<string[]>;
}
