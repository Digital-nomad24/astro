import type { AuthProvider, Role } from '@astro/contracts';

/**
 * The caller, as every guarded handler sees it via `@CurrentUser()`.
 *
 * This is the resolved **Postgres** identity, not the raw Firebase token — `id` is what every
 * other table's foreign keys point at, and no use case should ever need to know a
 * `firebaseUid`. The reference repo skipped this step, so its handlers all received a
 * `FirebaseAuthUser` and had to re-resolve the real user themselves on the first line of
 * every use case.
 *
 * Kept deliberately small: it is cached in Redis on the hot path of every authenticated
 * request, and anything mutable that is not needed for authorization belongs in `GET /me`
 * instead.
 */
export interface AuthenticatedUser {
  /** Postgres `User.id`. The id used everywhere else in the system. */
  readonly id: string;
  readonly firebaseUid: string;
  readonly role: Role;
  readonly authProvider: AuthProvider;
  readonly email: string | null;
  readonly displayName: string | null;
  /** Null until the profile step is complete; `@RequireOnboarded()` gates on this. */
  readonly onboardedAt: Date | null;
}
