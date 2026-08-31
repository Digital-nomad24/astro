import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';
import { SessionsModule } from '../sessions/sessions.module';
import { ChatIdleScheduler } from './application/schedulers/chat-idle.scheduler';
import { ChatRetentionScheduler } from './application/schedulers/chat-retention.scheduler';
import { ChatService } from './application/services/chat.service';
import { ChatController } from './entry-points/http/chat.controller';
import { ChatGateway } from './entry-points/sockets/chat.gateway';
import { ChatMessagePrismaRepo } from './infra/db/prisma/repos/chat-message.prisma.repo';
import { ChatRateLimitService } from './infra/redis/chat-rate-limit.service';
import { CHAT_MESSAGE_REPO } from './tokens';

@Module({
  // IdentityModule for the socket handshake; SessionsModule for `SessionLifecycleService` —
  // authorisation, the ended-session broadcast, and the idle sweeper's termination all go
  // through that application service rather than through the sessions repo.
  imports: [IdentityModule, SessionsModule],
  controllers: [ChatController],
  providers: [
    ChatService,
    ChatGateway,
    ChatRateLimitService,
    ChatIdleScheduler,
    ChatRetentionScheduler,
    { provide: CHAT_MESSAGE_REPO, useClass: ChatMessagePrismaRepo },
  ],
  // Exported for M8: the summariser reads the transcript through this port, and it is the
  // thing that will let `findPurgeableTranscripts` start returning SUMMARISED candidates.
  exports: [ChatService, CHAT_MESSAGE_REPO],
})
export class ChatModule {}
