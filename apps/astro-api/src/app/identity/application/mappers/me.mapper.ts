import type { AuthProvider, Role } from '@astro/contracts';

import type { IAuthUserRecord } from '../../domain/repos/auth-user.repo.interface';

/** The wire shape of the authenticated user's own profile. */
export interface MeResponse {
  id: string;
  role: Role;
  authProvider: AuthProvider;
  email: string | null;
  phoneNumber: string | null;
  displayName: string | null;
  photoUrl: string | null;
  onboardedAt: string | null;
  createdAt: string;
}

/**
 * Never return a Prisma row directly: it would leak `firebaseUid` (an identifier for another
 * system that no client needs) and would serialise any future BigInt column into a throw.
 */
export const toMeResponse = (record: IAuthUserRecord): MeResponse => ({
  id: record.id,
  role: record.role,
  authProvider: record.authProvider,
  email: record.email,
  phoneNumber: record.phoneNumber,
  displayName: record.displayName,
  photoUrl: record.photoUrl,
  onboardedAt: record.onboardedAt ? record.onboardedAt.toISOString() : null,
  createdAt: record.createdAt.toISOString(),
});
