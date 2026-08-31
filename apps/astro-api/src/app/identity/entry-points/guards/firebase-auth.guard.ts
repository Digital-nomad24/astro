import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenError, UnauthorizedError } from '@astro/errors';
import type { Role } from '@astro/contracts';
import type { Request } from 'express';

import { IdentityResolutionService } from '../../application/services/identity-resolution.service';
import { IS_PUBLIC_KEY, REQUIRE_ONBOARDED_KEY, ROLES_KEY } from '../../contracts/decorators';

/**
 * Registered as `APP_GUARD`, so **authentication is on by default** and a route has to opt
 * out with `@Public()`. The reference repo inverted this and repeated
 * `@UseGuards(FirebaseAuthGuard)` on 53 handlers, where forgetting one silently published an
 * endpoint. Here, forgetting anything fails closed.
 *
 * Authentication and authorization are in one guard rather than two on purpose: the role and
 * onboarding checks need the resolved user, so splitting them would either re-resolve the
 * identity or depend on guard ordering, and ordering bugs here are silent.
 */
@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly identity: IdentityResolutionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // WebSocket handshakes authenticate in the gateway, against the same
    // `IdentityResolutionService`. A global HTTP guard must not try to read an
    // `Authorization` header off a socket.
    if (context.getType() !== 'http') return true;

    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const user = await this.identity.authenticate(bearerTokenFrom(request));
    request.user = user;

    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, targets);
    if (roles?.length && !roles.includes(user.role)) {
      throw new ForbiddenError(
        'INSUFFICIENT_ROLE',
        'Your account does not have access to this resource.',
        { required: roles, actual: user.role },
      );
    }

    if (this.reflector.getAllAndOverride<boolean>(REQUIRE_ONBOARDED_KEY, targets)) {
      if (!user.onboardedAt) {
        throw new ForbiddenError(
          'ONBOARDING_REQUIRED',
          'Complete your profile before using this feature.',
        );
      }
    }

    return true;
  }
}

function bearerTokenFrom(request: Request): string {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new UnauthorizedError('MISSING_TOKEN', 'Missing Authorization bearer token');
  }

  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    throw new UnauthorizedError('MISSING_TOKEN', 'Missing bearer token');
  }
  return token;
}
