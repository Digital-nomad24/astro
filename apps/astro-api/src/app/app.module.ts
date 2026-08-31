import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';

import { PrismaModule } from 'prisma/prisma.module';
import { envSchema } from '../config/env.schema';
import { ChatModule } from './chat/chat.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { HealthModule } from './common/health/health.module';
import { LoggingModule } from './common/logging/logging.module';
import { IdentityModule } from './identity/identity.module';
import { RedisModule } from './infra/redis/redis.module';
import { MentorsModule } from './mentors/mentors.module';
import { PresenceModule } from './presence/presence.module';
import { QueueModule } from './queue/queue.module';
import { ReviewsModule } from './reviews/reviews.module';
import { SessionsModule } from './sessions/sessions.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (config: Record<string, unknown>) => envSchema.parse(config),
      expandVariables: true,
    }),
    LoggingModule,
    ScheduleModule.forRoot(),
    PrismaModule,
    RedisModule,
    // Registers the global APP_GUARD, so every route below is authenticated unless it is
    // explicitly @Public().
    IdentityModule,
    HealthModule,
    MentorsModule,
    PresenceModule,
    SessionsModule,
    ChatModule,
    QueueModule,
    ReviewsModule,
    // Domain modules land here: summaries (M8), billing (M10).
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
