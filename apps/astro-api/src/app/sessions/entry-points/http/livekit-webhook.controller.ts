import { Controller, HttpCode, Logger, Post, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { UnauthorizedError } from '@astro/errors';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

import { Public } from '../../../identity/contracts/decorators';
import { LiveKitWebhookProcessor } from '../../application/services/livekit-webhook.processor';

/**
 * Inbound LiveKit webhooks. The source of truth for voice session lifecycle.
 *
 * Three things about this controller are unusual, and all three are required:
 *
 * 1. **`@Public()`.** LiveKit has no Firebase identity. Authentication here is the signed
 *    `Authorization` JWT over the body digest, verified in the processor. This is one of the
 *    very few holes in the perimeter and `auth-routes.e2e-spec.ts` asserts the full list.
 *
 * 2. **`@Req()` only — no DTO, no `@Body()`.** The global
 *    `ValidationPipe({ forbidNonWhitelisted: true })` would reject any LiveKit field not
 *    declared on a DTO, so every schema addition on their side would become a 400 on ours.
 *    Validation of this payload is the signature, not a shape.
 *
 * 3. **The raw body, not the parsed one.** The signature covers the exact bytes LiveKit sent.
 *    Re-serialising the parsed object changes key order and number formatting, and the digest
 *    fails. `main.ts` boots with `rawBody: true` and widens the JSON parser to accept
 *    `application/webhook+json`, which is the content type LiveKit actually uses — Express's
 *    default parser ignores it and hands the handler an empty body.
 */
@ApiExcludeController()
@Controller('webhooks')
export class LiveKitWebhookController {
  private readonly logger = new Logger(LiveKitWebhookController.name);

  constructor(private readonly processor: LiveKitWebhookProcessor) {}

  @Public()
  @Post('livekit')
  @HttpCode(200)
  async receive(@Req() request: RawBodyRequest<Request>): Promise<{ received: true }> {
    const rawBody = request.rawBody?.toString('utf8');
    if (!rawBody) {
      // Almost always a misconfiguration rather than an attack: `rawBody: true` missing, or
      // the parser not widened for `application/webhook+json`. Named explicitly because the
      // symptom — every webhook 401s — points nowhere near the cause.
      this.logger.error({
        event: 'livekit.webhook.empty_body',
        contentType: request.headers['content-type'],
      });
      throw new UnauthorizedError(
        'INVALID_WEBHOOK_SIGNATURE',
        'Webhook signature verification failed.',
      );
    }

    const authHeader = request.headers.authorization;
    const { isNew, event } = await this.processor.accept(rawBody, authHeader);

    // Deliberately NOT awaited. The 200 goes out as soon as this handler returns, which is
    // what stops LiveKit retrying an event we have already accepted durably. Processing that
    // fails — or that never runs because the process dies here — is picked up by the inbox
    // sweeper, because `processedAt` is still null.
    if (isNew) {
      void this.processor.process(event);
    }

    return { received: true };
  }
}
