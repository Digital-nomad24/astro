import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';
import { MentorsModule } from '../mentors/mentors.module';
import { PresenceModule } from '../presence/presence.module';
import { SessionSweeperScheduler } from './application/schedulers/session-sweeper.scheduler';
import { WebhookRetryScheduler } from './application/schedulers/webhook-retry.scheduler';
import { LiveKitWebhookProcessor } from './application/services/livekit-webhook.processor';
import { SessionLifecycleService } from './application/services/session-lifecycle.service';
import {
  AcceptSessionUseCase,
  CancelSessionUseCase,
  DeclineSessionUseCase,
  EndSessionUseCase,
  GetActiveSessionUseCase,
  GetSessionUseCase,
  IssueSessionCredentialsUseCase,
  ListSessionsUseCase,
  RecordConsentUseCase,
  StartSessionUseCase,
} from './application/use-cases/session.use-cases';
import { LiveKitWebhookController } from './entry-points/http/livekit-webhook.controller';
import { SessionsController } from './entry-points/http/sessions.controller';
import { CallsGateway } from './entry-points/sockets/calls.gateway';
import { SessionPrismaRepo } from './infra/db/prisma/repos/session.prisma.repo';
import { WebhookEventPrismaRepo } from './infra/db/prisma/repos/webhook-event.prisma.repo';
import { LiveKitService } from './infra/livekit/livekit.service';
import { SESSION_REPO, WEBHOOK_EVENT_REPO } from './tokens';

@Module({
  // IdentityModule for socket handshake auth; MentorsModule for the profile and its frozen
  // economics; PresenceModule to flip the mentor BUSY for the duration of a session.
  imports: [IdentityModule, MentorsModule, PresenceModule],
  controllers: [SessionsController, LiveKitWebhookController],
  providers: [
    SessionLifecycleService,
    LiveKitWebhookProcessor,
    LiveKitService,
    CallsGateway,
    SessionSweeperScheduler,
    WebhookRetryScheduler,
    StartSessionUseCase,
    AcceptSessionUseCase,
    DeclineSessionUseCase,
    CancelSessionUseCase,
    EndSessionUseCase,
    RecordConsentUseCase,
    IssueSessionCredentialsUseCase,
    GetSessionUseCase,
    GetActiveSessionUseCase,
    ListSessionsUseCase,
    { provide: SESSION_REPO, useClass: SessionPrismaRepo },
    { provide: WEBHOOK_EVENT_REPO, useClass: WebhookEventPrismaRepo },
  ],
  // Exported for M5 (text chat reuses the state machine and the accept path rather than
  // forking it), M6 (the queue dispatcher creates RINGING sessions), M7 (reviews attach to a
  // completed session), M8 (summaries) and M10 (the meter reads the frozen economics).
  exports: [SessionLifecycleService, SESSION_REPO],
})
export class SessionsModule {}
