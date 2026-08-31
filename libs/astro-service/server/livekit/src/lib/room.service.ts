import { RoomServiceClient, ServerError } from 'livekit-server-sdk';

import { httpUrlFromLiveKitUrl, type LiveKitConfig } from './config';
import { parseParticipantIdentity, type ParticipantRole } from './naming';

export interface EnsureRoomParams {
  readonly roomName: string;
  /** How long the room survives with nobody in it — the ring window plus media setup. */
  readonly emptyTimeoutSeconds: number;
  /** Grace after the last participant leaves, so a dropped connection can rejoin. */
  readonly departureTimeoutSeconds: number;
  /** Opaque JSON handed to both clients on join. Never put anything secret in it. */
  readonly metadata?: string;
}

export interface LiveKitRoom {
  readonly sid: string;
  readonly name: string;
}

export interface LiveKitParticipant {
  readonly identity: string;
  readonly role: ParticipantRole | null;
  readonly userId: string | null;
  readonly joinedAtMs: number;
}

/**
 * The only place this codebase talks to LiveKit's room API.
 *
 * Framework-free on purpose: the Nest wiring lives in the sessions module, so this stays
 * unit-testable and the app never grows a second, subtly different LiveKit client.
 */
export class LiveKitRoomService {
  private readonly client: RoomServiceClient;

  constructor(private readonly config: LiveKitConfig) {
    this.client = new RoomServiceClient(
      httpUrlFromLiveKitUrl(config.url),
      config.apiKey,
      config.apiSecret,
    );
  }

  /**
   * Creates the room for a session, or returns the existing one.
   *
   * LiveKit's `CreateRoom` is idempotent on the room name, which is exactly why room names are
   * derived from the session id rather than randomly generated: a retried call after a network
   * blip rejoins the room the other party is already in, instead of opening a second room that
   * nobody is listening to and that we would keep paying for.
   *
   * `maxParticipants: 2` is a security boundary, not a capacity hint. A consultation is two
   * people; if a join token ever leaks, the cap is what stops a third party silently
   * subscribing to a private conversation.
   *
   * NOTE for M8: verify whether the egress recorder counts against this cap before enabling
   * recording. It connects hidden, but "hidden" and "uncounted" are not the same guarantee,
   * and finding out from a failed `StartEgress` on a live call is the wrong time.
   */
  async ensureRoom(params: EnsureRoomParams): Promise<LiveKitRoom> {
    const room = await this.client.createRoom({
      name: params.roomName,
      emptyTimeout: params.emptyTimeoutSeconds,
      departureTimeout: params.departureTimeoutSeconds,
      maxParticipants: 2,
      ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
    });

    return { sid: room.sid, name: room.name };
  }

  /**
   * Ends the call by destroying the room. Every participant is disconnected and LiveKit emits
   * `room_finished`, which is the event the session lifecycle settles on.
   *
   * Returns false when the room was already gone. That is a normal outcome, not an error:
   * both parties hanging up races the ring-timeout sweeper and the M10 balance cutoff, and
   * every one of those paths ends with "make sure this room is closed".
   */
  async deleteRoom(roomName: string): Promise<boolean> {
    try {
      await this.client.deleteRoom(roomName);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  /** Empty for a room that no longer exists — "nobody is in it" is the honest answer. */
  async listParticipants(roomName: string): Promise<LiveKitParticipant[]> {
    try {
      const participants = await this.client.listParticipants(roomName);
      return participants.map((participant) => {
        const parsed = parseParticipantIdentity(participant.identity);
        return {
          identity: participant.identity,
          role: parsed?.role ?? null,
          userId: parsed?.userId ?? null,
          joinedAtMs: Number(participant.joinedAt) * 1000,
        };
      });
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  /** Disconnects one side without ending the session — used when a party is removed. */
  async removeParticipant(roomName: string, identity: string): Promise<boolean> {
    try {
      await this.client.removeParticipant(roomName, identity);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }
}

/**
 * LiveKit reports a missing room or participant as a Twirp `not_found`. Matched on both the
 * Twirp code and the HTTP status, because the two have not always agreed across versions and
 * treating a real failure as "already gone" would silently strand a live room.
 */
function isNotFound(error: unknown): boolean {
  if (!(error instanceof ServerError)) return false;
  return error.code === 'not_found' || error.status === 404;
}
