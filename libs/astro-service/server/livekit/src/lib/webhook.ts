import { createHash } from 'node:crypto';
import { WebhookReceiver, type WebhookEvent } from 'livekit-server-sdk';

import type { LiveKitCredential } from './config';
import { parseParticipantIdentity, sessionIdFromRoomName, type ParticipantRole } from './naming';

/** The subset of LiveKit's event names this product acts on. Others are stored and ignored. */
export const LIVEKIT_EVENT_TYPES = [
  'room_started',
  'room_finished',
  'participant_joined',
  'participant_left',
  'egress_started',
  'egress_updated',
  'egress_ended',
] as const;
export type LiveKitEventType = (typeof LIVEKIT_EVENT_TYPES)[number];

export interface VerifiedLiveKitEvent {
  /** LiveKit's own event uuid — the inbox's idempotency key. */
  readonly eventId: string;
  readonly type: string;
  readonly roomName: string | null;
  readonly roomSid: string | null;
  /** Recovered from the room name. Null for any room we did not create. */
  readonly sessionId: string | null;
  readonly participant: {
    readonly identity: string;
    readonly role: ParticipantRole | null;
    readonly userId: string | null;
  } | null;
  readonly egressId: string | null;
  readonly createdAtMs: number;
  /** Parsed JSON, for the inbox payload column. Never re-serialised for verification. */
  readonly payload: unknown;
}

/** Raised when no configured credential verifies the request. Maps to 401 at the controller. */
export class LiveKitWebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveKitWebhookVerificationError';
  }
}

/**
 * Verifies inbound LiveKit webhooks against every configured credential.
 *
 * The signature is a JWT in the `Authorization` header carrying a SHA-256 of the body, so the
 * body must be the **exact bytes LiveKit sent**. Anything that re-serialises the parsed
 * object — even `JSON.stringify(JSON.parse(body))` — changes key order or number formatting
 * and fails the digest. That is why `main.ts` boots with `rawBody: true`.
 *
 * Credentials are tried newest-first and the first that verifies wins, so a key rotation has
 * an overlap window instead of a cliff.
 */
export class LiveKitWebhookVerifier {
  private readonly receivers: readonly WebhookReceiver[];

  constructor(credentials: readonly LiveKitCredential[]) {
    if (credentials.length === 0) {
      throw new Error('LiveKitWebhookVerifier requires at least one credential pair.');
    }
    this.receivers = credentials.map(
      (credential) => new WebhookReceiver(credential.apiKey, credential.apiSecret),
    );
  }

  async verify(rawBody: string, authHeader: string | undefined): Promise<VerifiedLiveKitEvent> {
    if (!authHeader) {
      throw new LiveKitWebhookVerificationError('Missing Authorization header.');
    }

    let lastError: unknown;
    for (const receiver of this.receivers) {
      try {
        return normalizeEvent(await receiver.receive(rawBody, authHeader), rawBody);
      } catch (error) {
        lastError = error;
      }
    }

    // Deliberately does not say WHICH credential failed or how. A webhook endpoint is
    // unauthenticated by definition, so its error messages are a probing surface.
    throw new LiveKitWebhookVerificationError(
      `No configured LiveKit credential verified this webhook (${describe(lastError)}).`,
    );
  }
}

function normalizeEvent(event: WebhookEvent, rawBody: string): VerifiedLiveKitEvent {
  const roomName = event.room?.name ?? null;
  const identity = event.participant?.identity ?? null;
  const parsedIdentity = identity ? parseParticipantIdentity(identity) : null;

  return {
    eventId: event.id || syntheticEventId(rawBody),
    type: event.event,
    roomName,
    roomSid: event.room?.sid ?? null,
    sessionId: roomName ? sessionIdFromRoomName(roomName) : null,
    participant: identity
      ? {
          identity,
          role: parsedIdentity?.role ?? null,
          userId: parsedIdentity?.userId ?? null,
        }
      : null,
    egressId: event.egressInfo?.egressId ?? null,
    // `createdAt` is a bigint of SECONDS. Multiplying before the Number conversion would
    // overflow nothing here, but converting first keeps it a plain number everywhere else —
    // `JSON.stringify` throws on a bigint, and this value ends up in a log line.
    createdAtMs: Number(event.createdAt) * 1000,
    payload: safeParse(rawBody),
  };
}

/**
 * Fallback identity for an event LiveKit sent without one.
 *
 * A digest of the exact body preserves the property the inbox actually needs: a redelivery of
 * the same event is byte-identical and therefore collides on the unique index. Falling back to
 * a random id would turn every retry into a fresh row and re-process it.
 */
function syntheticEventId(rawBody: string): string {
  return `sha256:${createHash('sha256').update(rawBody).digest('hex')}`;
}

function safeParse(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return { unparsed: rawBody };
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
