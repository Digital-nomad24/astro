import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { HealthController } from './health.controller';
import { HealthIndicators } from './health.indicators';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [HealthIndicators],
})
export class HealthModule {}
