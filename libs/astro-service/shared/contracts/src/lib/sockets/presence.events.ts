import type { PresenceState } from '../enums';
import type { Ack, CommonAckError } from './ack';

/** What a browsing client renders on a mentor card, and what a mentor sees about themselves. */
export interface MentorPresenceSnapshot {
  readonly mentorProfileId: string;
  readonly categorySlug: string;
  readonly state: PresenceState;
  readonly acceptingNewCalls: boolean;
  readonly queueDepth: number;
  readonly ratePaisePerMinute: number;
  /** Server clock. Clients use it to discard snapshots that arrive out of order. */
  readonly updatedAtMs: number;
}

export const PRESENCE_NAMESPACE = '/presence' as const;

export type PresenceAckError =
  | CommonAckError
  | 'not_a_mentor'
  | 'not_approved'
  | 'not_online'
  | 'too_many_ids';

/** Server → client. */
export interface PresenceServerToClient {
  /**
   * Emitted once authentication and identity resolution have completed. A client MUST wait
   * for this before subscribing or announcing — the socket exists before `client.data.user`
   * does, and acting in that window is the race the two-phase handshake removes.
   */
  'presence:ready': () => void;
  'presence:changed': (payload: MentorPresenceSnapshot) => void;
  /** The server took the mentor offline: suspended, stale, or an admin action. */
  'presence:forced-offline': (payload: {
    reason: 'stale' | 'suspended' | 'admin';
  }) => void;
}

/** Client → server. Every handler returns an ack; none of them throw. */
export interface PresenceClientToServer {
  'presence:subscribe': (
    payload: { categorySlugs?: string[]; mentorProfileIds?: string[] },
    ack: (result: Ack<{ snapshot: MentorPresenceSnapshot[] }, PresenceAckError>) => void,
  ) => void;
  'presence:unsubscribe': (
    payload: { categorySlugs?: string[]; mentorProfileIds?: string[] },
    ack: (result: Ack<Record<never, never>, PresenceAckError>) => void,
  ) => void;

  'mentor:go-online': (
    payload: { acceptingNewCalls?: boolean },
    ack: (
      result: Ack<{ state: PresenceState; ttlSeconds: number }, PresenceAckError>,
    ) => void,
  ) => void;
  'mentor:go-offline': (
    payload: Record<never, never>,
    ack: (result: Ack<{ state: 'OFFLINE' }, PresenceAckError>) => void,
  ) => void;
  /** Stay online but stop taking new sessions — used to drain a queue before logging off. */
  'mentor:set-accepting': (
    payload: { accepting: boolean },
    ack: (result: Ack<{ acceptingNewCalls: boolean }, PresenceAckError>) => void,
  ) => void;

  /**
   * Refreshes the mentor's Redis TTL. Missing several in a row is what marks them offline,
   * which is why the TTL must be a multiple of the heartbeat interval — see the cross-field
   * check in the env schema.
   */
  'presence:heartbeat': (
    payload: Record<never, never>,
    ack: (result: Ack<{ ttlSeconds: number }, PresenceAckError>) => void,
  ) => void;
}

/**
 * Subscription fan-out limits, shared so a client can page up to them rather than discover
 * them by being rejected. Exceeding either returns `too_many_ids` as an ack.
 */
export const PRESENCE_MAX_SUBSCRIBED_IDS = 200 as const;
export const PRESENCE_MAX_SUBSCRIBED_CATEGORIES = 50 as const;
