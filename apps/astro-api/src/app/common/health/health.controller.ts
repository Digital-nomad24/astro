import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { ApiTags } from '@nestjs/swagger';

import { Public } from '../../identity/contracts/decorators';
import { HealthIndicators } from './health.indicators';

/**
 * Liveness (`GET /health`) — the process is up and can answer. The platform restarts on
 * failure, so it deliberately checks **nothing external**: a Redis blip must not cycle every
 * instance and take the whole fleet's WebSockets down with it.
 *
 * Readiness (`GET /health/ready`) — Postgres and Redis are reachable. Gates traffic, and is
 * what the Cloud Run startup probe waits on.
 *
 * Both are `@Public()` by necessity: Cloud Run's startup and liveness probes cannot present a
 * bearer token, so guarding these would fail every deploy at the probe stage.
 */
@Public()
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: HealthIndicators,
  ) {}

  @Get()
  @HealthCheck()
  liveness() {
    return this.health.check([]);
  }

  @Get('ready')
  @HealthCheck()
  readiness() {
    return this.health.check([() => this.indicators.db(), () => this.indicators.redisPing()]);
  }
}
