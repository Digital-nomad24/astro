import { createHash } from 'node:crypto';

import {
  LiveKitWebhookVerificationError,
  LiveKitWebhookVerifier,
  httpUrlFromLiveKitUrl,
  mintJoinToken,
  parseParticipantIdentity,
  parseWebhookCredentials,
  participantIdentity,
  roomNameForSession,
  sessionIdFromRoomName,
  type LiveKitConfig,
} from '@astro/livekit';
import { AccessToken } from 'livekit-server-sdk';
import { decodeJwt } from 'jose';

const API_KEY = 'APItestkey';
const API_SECRET = 'a-secret-long-enough-for-hs256-signing';

const config: LiveKitConfig = {
  url: 'wss://astro-test.livekit.cloud',
  apiKey: API_KEY,
  apiSecret: API_SECRET,
  webhookCredentials: [{ apiKey: API_KEY, apiSecret: API_SECRET }],
};

/**
 * Produces the `Authorization` header LiveKit would send: a JWT issued by the API key,
 * carrying a base64 SHA-256 of the exact body bytes.
 */
async function signWebhook(
  body: string,
  credential = { apiKey: API_KEY, apiSecret: API_SECRET },
): Promise<string> {
  const token = new AccessToken(credential.apiKey, credential.apiSecret, { ttl: 300 });
  token.sha256 = createHash('sha256').update(body).digest('base64');
  return token.toJwt();
}

const webhookBody = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    event: 'participant_joined',
    id: 'evt_abc123',
    createdAt: 1_775_000_000,
    room: { sid: 'RM_1', name: 'session:ses_1' },
    participant: { identity: 'mentor:usr_2', joinedAt: 1_775_000_000 },
    ...overrides,
  });

describe('livekit naming', () => {
  it('round-trips a session id through a room name', () => {
    // Deterministic and reversible in both directions is what lets a webhook — which knows
    // only a room name — be attributed without a lookup table.
    const roomName = roomNameForSession('ses_abc');
    expect(sessionIdFromRoomName(roomName)).toBe('ses_abc');
  });

  it('refuses to claim a room it did not create', () => {
    expect(sessionIdFromRoomName('some-other-room')).toBeNull();
    expect(sessionIdFromRoomName('session:')).toBeNull();
  });

  it('round-trips a participant identity, carrying the role', () => {
    // The role is embedded so `participant_joined` can tell which side arrived — the fact that
    // decides whether the billing anchor may be stamped — with no database round trip.
    expect(parseParticipantIdentity(participantIdentity('mentor', 'usr_2'))).toEqual({
      role: 'mentor',
      userId: 'usr_2',
    });
  });

  it('rejects an identity with an unknown role', () => {
    expect(parseParticipantIdentity('admin:usr_9')).toBeNull();
    expect(parseParticipantIdentity('usr_9')).toBeNull();
    expect(parseParticipantIdentity(':usr_9')).toBeNull();
  });
});

describe('httpUrlFromLiveKitUrl', () => {
  it('swaps the websocket scheme for the HTTP one the server API needs', () => {
    // LIVEKIT_URL is the client-facing wss:// URL because that is what the console shows and
    // what the browser SDK needs. Handing it straight to RoomServiceClient fails obscurely.
    expect(httpUrlFromLiveKitUrl('wss://x.livekit.cloud')).toBe('https://x.livekit.cloud');
    expect(httpUrlFromLiveKitUrl('ws://localhost:7880')).toBe('http://localhost:7880');
    expect(httpUrlFromLiveKitUrl('https://x.livekit.cloud/')).toBe('https://x.livekit.cloud');
  });
});

describe('parseWebhookCredentials', () => {
  const primary = { apiKey: API_KEY, apiSecret: API_SECRET };

  it('always includes the primary pair first', () => {
    // An empty or malformed env value must degrade to "verify with the configured
    // credentials", never to "verify with nothing".
    expect(parseWebhookCredentials(primary, undefined)).toEqual([primary]);
    expect(parseWebhookCredentials(primary, '   ,  ')).toEqual([primary]);
  });

  it('reads a bare secret as a rotation under the same key', () => {
    expect(parseWebhookCredentials(primary, 'older-secret')).toEqual([
      primary,
      { apiKey: API_KEY, apiSecret: 'older-secret' },
    ]);
  });

  it('reads key:secret as a full pair, splitting on the FIRST colon only', () => {
    // A secret may itself contain colons; splitting on all of them would silently truncate it.
    expect(parseWebhookCredentials(primary, 'APIold:sec:ret:with:colons')).toEqual([
      primary,
      { apiKey: 'APIold', apiSecret: 'sec:ret:with:colons' },
    ]);
  });

  it('de-duplicates a re-declared primary', () => {
    expect(parseWebhookCredentials(primary, `${API_KEY}:${API_SECRET}`)).toEqual([primary]);
  });
});

describe('mintJoinToken', () => {
  it('grants microphone only — voice-only is enforced at the grant, not the UI', async () => {
    const minted = await mintJoinToken({
      config,
      roomName: 'session:ses_1',
      role: 'user',
      userId: 'usr_1',
      displayName: 'Guest',
      sessionId: 'ses_1',
      ttlSeconds: 600,
    });

    const claims = decodeJwt(minted.token) as {
      video?: Record<string, unknown>;
      sub?: string;
    };

    expect(claims.video?.roomJoin).toBe(true);
    expect(claims.video?.room).toBe('session:ses_1');
    // `canPublishSources` supersedes `canPublish`, so listing only the microphone means the
    // SFU itself refuses a camera track. Enabling VIDEO later is a change here, not a rewrite.
    expect(claims.video?.canPublishSources).toEqual(['microphone']);
    // Chat is a persisted ChatMessage log over our own gateway. An open data channel would be
    // a second, invisible chat that never reaches the history a user can page back through.
    expect(claims.video?.canPublishData).toBe(false);
    // A participant may join the one room named in the grant and nothing else.
    expect(claims.video?.roomCreate).toBeUndefined();
    expect(claims.video?.roomAdmin).toBeUndefined();

    expect(minted.identity).toBe('user:usr_1');
  });
});

describe('LiveKitWebhookVerifier', () => {
  it('accepts a correctly signed body and normalises it', async () => {
    const verifier = new LiveKitWebhookVerifier(config.webhookCredentials);
    const body = webhookBody();

    const event = await verifier.verify(body, await signWebhook(body));

    expect(event.eventId).toBe('evt_abc123');
    expect(event.type).toBe('participant_joined');
    expect(event.sessionId).toBe('ses_1');
    expect(event.participant).toEqual({
      identity: 'mentor:usr_2',
      role: 'mentor',
      userId: 'usr_2',
    });
    // createdAt is seconds on the wire and a bigint in the SDK. JSON.stringify throws on a
    // bigint, and this value ends up in a log line.
    expect(event.createdAtMs).toBe(1_775_000_000_000);
    expect(typeof event.createdAtMs).toBe('number');
  });

  it('rejects a tampered body whose signature is otherwise valid', async () => {
    const verifier = new LiveKitWebhookVerifier(config.webhookCredentials);
    const authHeader = await signWebhook(webhookBody());

    // Same valid, unexpired, correctly-issued JWT — but over different bytes. This is the
    // attack the sha256 claim exists to stop.
    await expect(
      verifier.verify(webhookBody({ room: { sid: 'RM_9', name: 'session:ses_9' } }), authHeader),
    ).rejects.toBeInstanceOf(LiveKitWebhookVerificationError);
  });

  it('rejects a body signed with an unconfigured secret', async () => {
    const verifier = new LiveKitWebhookVerifier(config.webhookCredentials);
    const body = webhookBody();

    await expect(
      verifier.verify(body, await signWebhook(body, { apiKey: API_KEY, apiSecret: 'wrong' })),
    ).rejects.toBeInstanceOf(LiveKitWebhookVerificationError);
  });

  it('rejects a missing Authorization header', async () => {
    const verifier = new LiveKitWebhookVerifier(config.webhookCredentials);
    await expect(verifier.verify(webhookBody(), undefined)).rejects.toBeInstanceOf(
      LiveKitWebhookVerificationError,
    );
  });

  it('accepts BOTH credentials during a key rotation overlap', async () => {
    // The whole reason webhookCredentials is a list. Rotating on LiveKit Cloud issues a new
    // key AND secret, and accepting only the new pair would reject every webhook still in
    // flight under the old one.
    const rotated = new LiveKitWebhookVerifier([
      { apiKey: 'APInew', apiSecret: 'new-secret-value-long-enough' },
      { apiKey: API_KEY, apiSecret: API_SECRET },
    ]);
    const body = webhookBody();

    await expect(rotated.verify(body, await signWebhook(body))).resolves.toMatchObject({
      eventId: 'evt_abc123',
    });
    await expect(
      rotated.verify(
        body,
        await signWebhook(body, { apiKey: 'APInew', apiSecret: 'new-secret-value-long-enough' }),
      ),
    ).resolves.toMatchObject({ eventId: 'evt_abc123' });
  });

  it('synthesises a body digest when LiveKit sends no event id', async () => {
    // The fallback has to preserve the property the inbox needs: a redelivery of the same
    // event is byte-identical, so it collides on the unique index. A random id would not.
    const verifier = new LiveKitWebhookVerifier(config.webhookCredentials);
    const body = webhookBody({ id: '' });
    const header = await signWebhook(body);

    const first = await verifier.verify(body, header);
    const second = await verifier.verify(body, header);

    expect(first.eventId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second.eventId).toBe(first.eventId);
  });

  it('refuses to construct with no credentials at all', () => {
    expect(() => new LiveKitWebhookVerifier([])).toThrow();
  });
});
