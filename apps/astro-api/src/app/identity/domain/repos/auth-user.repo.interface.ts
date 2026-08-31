import type { AuthProvider, Role } from '@astro/contracts';

/** The persisted identity. Mirrors the `User` row, minus anything no use case needs. */
export interface IAuthUserRecord {
  readonly id: string;
  readonly firebaseUid: string;
  readonly role: Role;
  readonly authProvider: AuthProvider;
  readonly email: string | null;
  readonly phoneNumber: string | null;
  readonly displayName: string | null;
  readonly photoUrl: string | null;
  readonly onboardedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface IProvisionAuthUserParams {
  readonly firebaseUid: string;
  readonly authProvider: AuthProvider;
  readonly email: string | null;
  readonly phoneNumber: string | null;
  readonly displayName: string | null;
  readonly photoUrl: string | null;
}

export interface IUpdateProfileParams {
  readonly displayName?: string;
  readonly photoUrl?: string | null;
}

export interface IAuthUserRepo {
  findByFirebaseUid(firebaseUid: string): Promise<IAuthUserRecord | null>;

  /**
   * Create the shadow row if it does not exist, then return it either way.
   *
   * Must be safe against two concurrent first requests from the same new user — a client that
   * fires several requests the instant it signs in is the normal case, not an edge case.
   */
  provision(params: IProvisionAuthUserParams): Promise<IAuthUserRecord>;

  /** Firebase is authoritative for the email; keep the shadow row from drifting. */
  syncEmail(firebaseUid: string, email: string | null): Promise<IAuthUserRecord>;

  updateProfile(userId: string, params: IUpdateProfileParams): Promise<IAuthUserRecord>;

  /** Stamps `onboardedAt` only if it is still null, so a repeat call never moves it. */
  markOnboarded(userId: string): Promise<IAuthUserRecord>;
}
