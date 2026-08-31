import { Inject, Injectable, Logger } from '@nestjs/common';
import { UnauthorizedError } from '@astro/errors';
import { LiveKitWebhookVerificationError, type VerifiedLiveKitEvent } from '@astro/livekit';

import type { IWebhookEventRecord, IWebhookEventRepo } from '../../domain/repos/session.repos';
import { LiveKitService } from '../../infra/livekit/livekit.service';
import { WEBHOOK_EVENT_REPO } from '../../tokens';
import { SessionLifecycleService } from './session-lifecycle.service';

export const LIVEKIT_WEBHOOK_SOURCE = 'livekit';

/**
 * The inbound half of the LiveKit integration.
 *
 * The contract is **verify → persist → 200 → process**, in that order, and each step is there
 * for a reason:
 *
 * - *Verify first* because an unauthenticated endpoint that writes to the database on request
 *   is a denial-of-service target with a storage bill attached.
 * - *Persist before responding* because a 200 tells LiveKit to stop retrying. Returning it
 *   before the event is durable means a crash in the next millisecond loses the event
 *   permanently, and for `room_finished` that is a session that never ends.
 * - *Process after responding* because doing the work inline races LiveKit's delivery timeout,
 *   and a timeout is indistinguishable from a rejection — it would retry an event we did in
 *   fact handle.
 *
 * The inbox's unique key makes the retry safe: a redelivery is a no-op insert, so the
 * expensive property (each event applied at most once) comes from a database constraint
 * rather than from processing being fast enough.
 */
@Injectable()
export class LiveKitWebhookProcessor {
  private readonly logger = new Logger(LiveKitWebhookProcessor.name);

  constructor(
    @Inject(WEBHOOK_EVENT_REPO) private readonly inbox: IWebhookEventRepo,
    private readonly livekit: LiveKitService,
    private readonly lifecycle: SessionLifecycleService,
  ) {}

  /**
   * Verifies the signature and records the event. Returns the inbox row plus whether this was
   * the first delivery — the caller responds 200 either way and only processes a first.
   */
  async accept(
    rawBody: string,
    authHeader: string | undefined,
  ): Promise<{ isNew: boolean; event: IWebhookEventRecord }> {
    let verified: VerifiedLiveKitEvent;
    try {
      verified = await this.livekit.verifyWebhook(rawBody, authHeader);
    } catch (error) {
      if (error instanceof LiveKitWebhookVerificationError) {
        this.logger.warn({
          event: 'livekit.webhook.invalid_signature',
          reason: error.message,
          bodyBytes: rawBody.length,
        });
        throw new UnauthorizedError(
          'INVALID_WEBHOOK_SIGNATURE',
          'Webhook signature verification failed.',
        );
      }
      throw error;
    }

    const recorded = await this.inbox.record({
      source: LIVEKIT_WEBHOOK_SOURCE,
      eventId: verified.eventId,
      eventType: verified.type,
      roomName: verified.roomName,
      participantIdentity: verified.participant?.identity ?? null,
      sessionId: verified.sessionId,
      payload: verified.payload,
    });

    this.logger.log({
      event: recorded.isNew ? 'livekit.webhook.verified' : 'livekit.webhook.duplicate',
      eventId: verified.eventId,
      type: verified.type,
      sessionId: verified.sessionId,
    });

    return recorded;
  }

  /**
   * Applies one inbox row. Idempotent on its own account as well as via the inbox: every
   * lifecycle call it makes is a conditional update, so re-running a processed event after a
   * crash between the work and the `markProcessed` changes nothing.
   */
  async process(event: IWebhookEventRecord): Promise<void> {
    try {
      await this.apply(event);
      await this.inbox.markProcessed(event.id);
    } catch (error) {
      const message = describe(error);
      await this.inbox.markFailed(event.id, message);
      this.logger.error({
        event: 'livekit.webhook.process_failed',
        eventId: event.eventId,
        type: event.eventType,
        attempts: event.attempts + 1,
        error: message,
      });
    }
  }

  private async apply(event: IWebhookEventRecord): Promise<void> {
    // A room we did not create — nothing here owns it, and guessing would be worse than
    // ignoring it. Marked processed so it does not sit in the retry queue forever.
    if (!event.sessionId) {
      this.logger.warn({
        event: 'livekit.webhook.unknown_room',
        roomName: event.roomName,
        type: event.eventType,
      });
      return;
    }

    switch (event.eventType) {
      case 'participant_joined':
        if (event.participantIdentity) {
          await this.lifecycle.onParticipantJoined(event.sessionId, event.participantIdentity);
        }
        return;

      case 'participant_left':
        if (event.participantIdentity) {
          await this.lifecycle.onParticipantLeft(event.sessionId, event.participantIdentity);
        }
        return;

      case 'room_finished':
        await this.lifecycle.onRoomFinished(event.sessionId, this.finishedAtMs(event));
        return;

      // We created the room, so this tells us nothing new. Recorded for the audit trail.
      case 'room_started':
        return;

      // Egress belongs to M8. Stored now so that when the summariser lands there is already a
      // history of what LiveKit reported, rather than a cold start on an unfamiliar event.
      case 'egress_started':
      case 'egress_updated':
      case 'egress_ended':
        this.logger.log({
          event: 'livekit.webhook.egress',
          type: event.eventType,
          sessionId: event.sessionId,
        });
        return;

      default:
        return;
    }
  }

  /**
   * When the room actually finished, per LiveKit.
   *
   * Falls back to our own receipt time if the payload's timestamp is missing or in the future.
   * A LiveKit clock ahead of ours would otherwise write an `endedAt` that has not happened,
   * and in M10 a duration computed against it would over-bill. Trusting the remote clock only
   * when it is not obviously wrong is the whole of the defence here.
   */
  private finishedAtMs(event: IWebhookEventRecord): number {
    const payload = event.payload;
    const createdAt =
      typeof payload === 'object' && payload !== null && 'createdAt' in payload
        ? Number((payload as { createdAt?: unknown }).createdAt)
        : Number.NaN;

    const receivedAtMs = event.receivedAt.getTime();
    if (!Number.isFinite(createdAt) || createdAt <= 0) return receivedAtMs;

    const reportedMs = createdAt * 1000;
    if (reportedMs > receivedAtMs) {
      this.logger.warn({
        event: 'livekit.webhook.clock_skew',
        eventId: event.eventId,
        reportedMs,
        receivedAtMs,
      });
      return receivedAtMs;
    }
    return reportedMs;
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
