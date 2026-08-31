import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { IdentityResolutionService } from './application/services/identity-resolution.service';
import { GetMeUseCase } from './application/use-cases/get-me.use-case';
import { UpdateMeUseCase } from './application/use-cases/update-me.use-case';
import { FirebaseAuthGuard } from './entry-points/guards/firebase-auth.guard';
import { MeController } from './entry-points/http/me.controller';
import { AuthUserPrismaRepo } from './infra/db/prisma/repos/auth-user.prisma.repo';
import { FirebaseService } from './infra/firebase/firebase.service';
import { AUTH_USER_REPO } from './tokens';

/**
 * `APP_GUARD` is provided here rather than in `AppModule` so the guard sits with the identity
 * it resolves. Nest applies it globally regardless of which module declares it.
 *
 * `IdentityResolutionService` and `FirebaseService` are exported because gateways
 * authenticate their handshakes through the same path from M3 — one verification code path
 * for HTTP and WebSocket, not two that can drift.
 */
@Module({
  controllers: [MeController],
  providers: [
    FirebaseService,
    IdentityResolutionService,
    GetMeUseCase,
    UpdateMeUseCase,
    { provide: AUTH_USER_REPO, useClass: AuthUserPrismaRepo },
    { provide: APP_GUARD, useClass: FirebaseAuthGuard },
  ],
  exports: [FirebaseService, IdentityResolutionService, AUTH_USER_REPO],
})
export class IdentityModule {}
