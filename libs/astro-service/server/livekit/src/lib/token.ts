import { AccessToken, type VideoGrant } from 'livekit-server-sdk';
import { TrackSource } from '@livekit/protocol';

import type { LiveKitConfig } from './config';
import { participantIdentity, type ParticipantRole } from './naming';

export interface MintJoinTokenParams {
  readonly config: LiveKitConfig;
  readonly roomName: string;
  readonly role: ParticipantRole;
  readonly userId: string;
  /** Shown to the other party as `Participant.name`. Never an id — this is user-visible. */
  readonly displayName: string;
  readonly ttlSeconds: number;
  readonly sessionId: string;
}

export interface MintedJoinToken {
  readonly token: string;
  readonly identity: string;
  readonly roomName: string;
  readonly expiresAtMs: number;
}

/**
 * Mints a per-participant join token.
 *
 * **Voice-only is enforced here, at the grant level — not in the UI.** `canPublishSources`
 * supersedes `canPublish`, so listing only `MICROPHONE` means a client that asks for a camera
 * track is refused by the SFU itself. A UI toggle would be a suggestion; this is the boundary,
 * and it is what makes `VIDEO` a grant change later rather than a re-architecture.
 *
 * `canPublishData: false` is the same argument applied to text. Chat is a persisted
 * `ChatMessage` log over our own gateway precisely because data channels are ephemeral and
 * unretrievable — leaving the data channel open would create a second, invisible chat that
 * never reaches the history a user can page back through.
 *
 * `roomCreate` and `roomAdmin` are absent: a participant may join the one room named in the
 * grant and nothing else. Room lifecycle is the server's, so a client cannot create a room
 * we are not billing for, nor delete the call it is losing.
 */
export async function mintJoinToken(params: MintJoinTokenParams): Promise<MintedJoinToken> {
  const identity = participantIdentity(params.role, params.userId);

  const token = new AccessToken(params.config.apiKey, params.config.apiSecret, {
    identity,
    name: params.displayName,
    ttl: params.ttlSeconds,
    // Read back off the participant by the other side, and echoed in `participant_joined`
    // webhooks. Carrying the session id means a webhook can be attributed even if the room
    // name convention ever changes under us.
    attributes: { sessionId: params.sessionId, role: params.role },
  });

  const grant: VideoGrant = {
    roomJoin: true,
    room: params.roomName,
    canSubscribe: true,
    canPublishSources: [TrackSource.MICROPHONE],
    canPublishData: false,
    canUpdateOwnMetadata: false,
    hidden: false,
  };
  token.addGrant(grant);

  return {
    token: await token.toJwt(),
    identity,
    roomName: params.roomName,
    expiresAtMs: Date.now() + params.ttlSeconds * 1000,
  };
}
