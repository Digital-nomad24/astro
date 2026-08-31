import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service';

/**
 * Global so `infra/db/prisma/repos/*` can inject `PrismaService` without every domain's infra
 * module re-importing it. Note the architectural rule this does NOT relax: use cases inject
 * `I*Repo` via their `@Inject(SYMBOL)` token, never `PrismaService` directly.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
