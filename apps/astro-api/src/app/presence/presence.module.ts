import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';
import { MentorsModule } from '../mentors/mentors.module';
import { PresenceSweeperScheduler } from './application/schedulers/presence-sweeper.scheduler';
import { PresenceService } from './application/services/presence.service';
import { PresenceGateway } from './entry-points/sockets/presence.gateway';
import { PresenceRedisRepo } from './infra/redis/presence.redis.repo';
import { PRESENCE_REPO } from './tokens';

@Module({
  // IdentityModule for socket handshake authentication; MentorsModule for the profile lookup
  // and the presence read-model write.
  imports: [IdentityModule, MentorsModule],
  providers: [
    PresenceService,
    PresenceGateway,
    PresenceSweeperScheduler,
    { provide: PRESENCE_REPO, useClass: PresenceRedisRepo },
  ],
  // Exported for the sessions module (M4), which flips a mentor to BUSY when a call starts,
  // and the queue module (M6), whose dispatcher only promotes to a reachable mentor.
  exports: [PresenceService, PRESENCE_REPO],
})
export class PresenceModule {}
