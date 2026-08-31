import { createHash } from 'node:crypto';

import { AccessToken } from 'livekit-server-sdk';

/**
 * Signs a webhook body exactly as LiveKit does: a JWT issued by the API key, carrying a
 * base64 SHA-256 of the **exact body bytes**.
 *
 * The digest is over the string that will be transmitted, which is why callers build the body
 * once and pass the same string here and to `.send()`. Re-serialising between the two would
 * change key order and silently break every signature — the same trap that makes `rawBody`
 * mandatory on the receiving side.
 */
export async function signLiveKitWebhook(
  body: string,
  credential?: { apiKey: string; apiSecret: string },
): Promise<string> {
  const apiKey = credential?.apiKey ?? process.env.LIVEKIT_API_KEY;
  const apiSecret = credential?.apiSecret ?? process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error('LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required to sign test webhooks.');
  }

  const token = new AccessToken(apiKey, apiSecret, { ttl: 300 });
  token.sha256 = createHash('sha256').update(body).digest('base64');
  return token.toJwt();
}

export interface WebhookBodyParams {
  readonly event: string;
  readonly eventId: string;
  readonly roomName: string;
  readonly participantIdentity?: string;
  readonly createdAtSeconds?: number;
}

/** A LiveKit webhook body, as JSON, ready to be signed and posted verbatim. */
export function liveKitWebhookBody(params: WebhookBodyParams): string {
  return JSON.stringify({
    event: params.event,
    id: params.eventId,
    createdAt: params.createdAtSeconds ?? Math.floor(Date.now() / 1000),
    room: { sid: `RM_${params.roomName}`, name: params.roomName },
    ...(params.participantIdentity
      ? {
          participant: {
            identity: params.participantIdentity,
            joinedAt: params.createdAtSeconds ?? Math.floor(Date.now() / 1000),
          },
        }
      : {}),
  });
}
