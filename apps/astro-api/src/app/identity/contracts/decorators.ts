import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Role } from '@astro/contracts';
import type { Request } from 'express';

import type { AuthenticatedUser } from './authenticated-user';

export const IS_PUBLIC_KEY = 'astro:isPublic';
export const ROLES_KEY = 'astro:roles';
export const REQUIRE_ONBOARDED_KEY = 'astro:requireOnboarded';

/**
 * Opt a route OUT of authentication.
 *
 * Authentication is on by default via `APP_GUARD` — the reference repo did the opposite,
 * repeating `@UseGuards(FirebaseAuthGuard)` on 53 handlers, where forgetting one silently
 * published an endpoint. Here forgetting something fails closed.
 *
 * Every use of this is a deliberate hole in the perimeter. `test/auth-routes.e2e-spec.ts`
 * asserts the full set of public routes against an explicit allowlist, so adding one without
 * thinking about it breaks the build.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Restrict a route to the given roles. Applied to a handler or a whole controller; the
 * handler wins when both are present.
 *
 * Note the distinction that matters for mentors: `@Roles('MENTOR')` means "this account is a
 * mentor", NOT "this mentor may take sessions". Approval lives on `MentorProfile`.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** Require a completed profile. Signing up is not the same as being ready to transact. */
export const RequireOnboarded = () => SetMetadata(REQUIRE_ONBOARDED_KEY, true);

/**
 * The resolved Postgres identity of the caller.
 *
 * Never optional on a guarded route: if the guard let the request through, this is populated,
 * which is why handlers can take `AuthenticatedUser` rather than `AuthenticatedUser | undefined`
 * and why the reference repo's `req.user!` non-null assertions are absent here.
 */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const user = request.user;
    return data ? user?.[data] : user;
  },
);
