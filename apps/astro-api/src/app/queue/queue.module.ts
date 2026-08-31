import { Module } from '@nestjs/common';

import { MentorsModule } from '../mentors/mentors.module';
import { PresenceModule } from '../presence/presence.module';
import { SessionsModule } from '../sessions/sessions.module';
import { QueueReconcilerScheduler } from './application/schedulers/queue-reconciler.scheduler';
import { QueueSweeperScheduler } from './application/schedulers/queue-sweeper.scheduler';
import { QueueService } from './application/services/queue.service';
import { QueueEntryPrismaRepo } from './infra/db/prisma/repos/queue-entry.prisma.repo';
import { QueueRedisRepo } from './infra/redis/queue.redis.repo';
import { QUEUE_ENTRY_REPO, QUEUE_REDIS_REPO } from './tokens';

/**
 * The queue depends on sessions; sessions does not depend on the queue.
 *
 * `QueueService` registers itself with `SessionLifecycleService` at init through the
 * `ISessionQueue` port. That inversion is what keeps the dependency one-directional even
 * though the relationship is genuinely mutual — the queue promotes sessions, and creating a
 * session consults the queue.
 *
 * It also means M6 is additive: remove this module from `AppModule` and a busy mentor is a
 * 409 again, exactly as in M4 and M5, with nothing else to unpick.
 */
@Module({
  imports: [SessionsModule, MentorsModule, PresenceModule],
  providers: [
    QueueService,
    QueueSweeperScheduler,
    QueueReconcilerScheduler,
    { provide: QUEUE_ENTRY_REPO, useClass: QueueEntryPrismaRepo },
    { provide: QUEUE_REDIS_REPO, useClass: QueueRedisRepo },
  ],
  // Exported for the /calls gateway, which pushes positions and reports disconnects.
  exports: [QueueService],
})
export class QueueModule {}
