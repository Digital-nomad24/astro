import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableError } from '@astro/errors';
import {
  LiveKitRoomService,
  LiveKitWebhookVerifier,
  httpUrlFromLiveKitUrl,
  mintJoinToken,
  parseWebhookCredentials,
  roomNameForSession,
  type LiveKitConfig,
  type MintedJoinToken,
  type ParticipantRole,
  type VerifiedLiveKitEvent,
} from '@astro/livekit';

import type { EnvVars } from '../../../../config/env.schema';

/**
 * The Nest-facing seam over `@astro/livekit`.
 *
 * LiveKit is **optional at boot and required at use**. The env schema only demands credentials
 * in production, so a developer working on mentors or chat can run the whole app without a
 * LiveKit project — but the moment someone tries to start a voice call, this fails loudly with
 * a 503 rather than producing a session whose room never existed. A half-created voice session
 * is worse than a refused one: it occupies the caller's in-flight slot.
 */
@Injectable()
export class LiveKitService implements OnModuleInit {
  private readonly logger = new Logger(LiveKitService.name);
  private readonly config: LiveKitConfig | null;
  private readonly rooms: LiveKitRoomService | null;
  private readonly verifier: LiveKitWebhookVerifier | null;
  private readonly tokenTtlSeconds: number;

  constructor(config: ConfigService<EnvVars, true>) {
    const url = config.get('LIVEKIT_URL', { infer: true });
    const apiKey = config.get('LIVEKIT_API_KEY', { infer: true });
    const apiSecret = config.get('LIVEKIT_API_SECRET', { infer: true });

    if (url && apiKey && apiSecret) {
      this.config = {
        url,
        apiKey,
        apiSecret,
        webhookCredentials: parseWebhookCredentials(
          { apiKey, apiSecret },
          config.get('LIVEKIT_WEBHOOK_SECRETS', { infer: true }),
        ),
      };
      this.rooms = new LiveKitRoomService(this.config);
      this.verifier = new LiveKitWebhookVerifier(this.config.webhookCredentials);
    } else {
      this.config = null;
      this.rooms = null;
      this.verifier = null;
    }

    // A join token must outlive the whole call, including the ring window before it and a
    // reconnect at the very end. An expired token mid-call cannot be renewed by the client on
    // its own — it would have to ask us for a new one while its transport is already down.
    this.tokenTtlSeconds =
      config.get('RING_TIMEOUT_S', { infer: true }) +
      config.get('SESSION_MAX_DURATION_S', { infer: true }) +
      config.get('SESSION_REJOIN_GRACE_S', { infer: true }) +
      300;
  }

  onModuleInit(): void {
    if (!this.config) {
      this.logger.warn(
        'LiveKit is not configured — voice sessions will be refused with 503. Set LIVEKIT_URL, ' +
          'LIVEKIT_API_KEY and LIVEKIT_API_SECRET to enable them.',
      );
      return;
    }
    this.logger.log(
      `LiveKit configured: ${httpUrlFromLiveKitUrl(this.config.url)} ` +
        `(${this.config.webhookCredentials.length} webhook credential(s) accepted)`,
    );
  }

  get isConfigured(): boolean {
    return this.config !== null;
  }

  /** The `wss://` URL a browser connects to — not the HTTPS host the server API uses. */
  get clientUrl(): string {
    return this.require().config.url;
  }

  roomNameFor(sessionId: string): string {
    return roomNameForSession(sessionId);
  }

  async ensureRoom(params: {
    sessionId: string;
    emptyTimeoutSeconds: number;
    departureTimeoutSeconds: number;
  }): Promise<{ name: string; sid: string }> {
    const { rooms } = this.require();
    return rooms.ensureRoom({
      roomName: roomNameForSession(params.sessionId),
      emptyTimeoutSeconds: params.emptyTimeoutSeconds,
      departureTimeoutSeconds: params.departureTimeoutSeconds,
      // Read by both clients on join. Session id only — never the rate, never the wallet.
      // Room metadata is visible to every participant and is not a place for anything a user
      // should not see about the other side.
      metadata: JSON.stringify({ sessionId: params.sessionId }),
    });
  }

  mintToken(params: {
    sessionId: string;
    role: ParticipantRole;
    userId: string;
    displayName: string;
  }): Promise<MintedJoinToken> {
    const { config } = this.require();
    return mintJoinToken({
      config,
      roomName: roomNameForSession(params.sessionId),
      role: params.role,
      userId: params.userId,
      displayName: params.displayName,
      sessionId: params.sessionId,
      ttlSeconds: this.tokenTtlSeconds,
    });
  }

  /**
   * Ends the call. Never throws for a room that is already gone — every path that closes a
   * session (hang-up, ring timeout, max duration, the M10 cutoff) races the others, and
   * "already closed" is success for all of them.
   */
  async closeRoom(roomName: string): Promise<boolean> {
    if (!this.rooms) return false;
    try {
      return await this.rooms.deleteRoom(roomName);
    } catch (error) {
      // Deliberately swallowed. The DB row is the record of truth for whether a session ended;
      // a LiveKit outage must not prevent us marking it ended, or the user is locked out of
      // starting another call by their own in-flight index.
      this.logger.error(
        `Failed to close LiveKit room ${roomName}: ${describe(error)}. The session is still ` +
          'being marked ended; the room will expire on its own emptyTimeout.',
      );
      return false;
    }
  }

  verifyWebhook(rawBody: string, authHeader: string | undefined): Promise<VerifiedLiveKitEvent> {
    return this.require().verifier.verify(rawBody, authHeader);
  }

  private require(): {
    config: LiveKitConfig;
    rooms: LiveKitRoomService;
    verifier: LiveKitWebhookVerifier;
  } {
    if (!this.config || !this.rooms || !this.verifier) {
      throw new ServiceUnavailableError(
        'LIVEKIT_NOT_CONFIGURED',
        'Voice calling is unavailable: this deployment has no LiveKit credentials.',
      );
    }
    return { config: this.config, rooms: this.rooms, verifier: this.verifier };
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
