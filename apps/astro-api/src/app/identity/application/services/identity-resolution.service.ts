import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedError } from '@astro/errors';
import { authProviderFromSignInProvider, type AuthProvider, type Role } from '@astro/contracts';
import type { DecodedIdToken } from 'firebase-admin/auth';
import type { Redis } from 'ioredis';

import type { EnvVars } from '../../../../config/env.schema';
import { REDIS_CLIENT } from '../../../infra/redis/redis.tokens';
import type { AuthenticatedUser } from '../../contracts/authenticated-user';
import type { IAuthUserRecord, IAuthUserRepo } from '../../domain/repos/auth-user.repo.interface';
import { FirebaseService } from '../../infra/firebase/firebase.service';
import { AUTH_USER_REPO } from '../../tokens';

/** What actually lives in Redis. Dates are ISO strings; JSON has no Date. */
interface CachedIdentity {
  id: string;
  firebaseUid: string;
  role: Role;
  authProvider: AuthProvider;
  email: string | null;
  displayName: string | null;
  onboardedAt: string | null;
}

/**
 * Turns a Firebase ID token into the Postgres identity every handler works with, provisioning
 * the shadow row on first sight.
 *
 * This replaces the reference repo's two-step flow, where clients had to call `POST /auth/sync`
 * before anything else worked and every use case opened with `requireSyncedUser()`. Doing it
 * in the guard means a user cannot be half-registered and no use case has to think about it.
 *
 * The Redis cache is what makes that affordable: without it, provisioning-in-the-guard would
 * mean a Postgres read on every authenticated request.
 */
@Injectable()
export class IdentityResolutionService {
  private readonly logger = new Logger(IdentityResolutionService.name);
  private readonly cacheTtlSeconds: number;

  constructor(
    @Inject(AUTH_USER_REPO) private readonly authUsers: IAuthUserRepo,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly firebase: FirebaseService,
    config: ConfigService<EnvVars, true>,
  ) {
    this.cacheTtlSeconds = config.get('IDENTITY_CACHE_TTL_S', { infer: true });
  }

  /**
   * Verify a raw bearer/handshake token and resolve the caller. Throws `UnauthorizedError`
   * for anything that is not a currently valid token.
   */
  async authenticate(idToken: string): Promise<AuthenticatedUser> {
    let decoded: DecodedIdToken;
    try {
      decoded = await this.firebase.verifyIdToken(idToken);
    } catch (err) {
      // Deliberately opaque to the caller: distinguishing "expired" from "forged" tells an
      // attacker which of the two they achieved. The real reason is logged.
      this.logger.debug(`ID token rejected: ${err instanceof Error ? err.message : String(err)}`);
      throw new UnauthorizedError('INVALID_TOKEN', 'Invalid or expired token');
    }
    return this.resolve(decoded);
  }

  /** Resolve an already-verified token. */
  async resolve(decoded: DecodedIdToken): Promise<AuthenticatedUser> {
    const cached = await this.readCache(decoded.uid);
    if (cached) return fromCache(cached);

    const existing = await this.authUsers.findByFirebaseUid(decoded.uid);
    const record = existing
      ? await this.reconcile(existing, decoded)
      : await this.provision(decoded);

    await this.writeCache(record);
    return toAuthenticated(record);
  }

  /** Drop the cached entry. Call after ANY write that changes role or onboardedAt. */
  async invalidate(firebaseUid: string): Promise<void> {
    try {
      await this.redis.del(cacheKey(firebaseUid));
    } catch (err) {
      // A stale entry expires on its own; failing the write would be worse.
      this.logger.warn(`Identity cache invalidation failed: ${asMessage(err)}`);
    }
  }

  private async provision(decoded: DecodedIdToken): Promise<IAuthUserRecord> {
    const record = await this.authUsers.provision({
      firebaseUid: decoded.uid,
      authProvider: authProviderFromSignInProvider(decoded.firebase?.sign_in_provider),
      email: normalizeEmail(decoded.email),
      phoneNumber: typeof decoded.phone_number === 'string' ? decoded.phone_number : null,
      displayName: typeof decoded.name === 'string' ? decoded.name : null,
      photoUrl: typeof decoded.picture === 'string' ? decoded.picture : null,
    });

    this.logger.log({
      event: 'identity.provisioned',
      userId: record.id,
      authProvider: record.authProvider,
    });
    return record;
  }

  /**
   * Firebase is authoritative for the email, so a change there (verification, a merged
   * provider, an admin edit) has to reach us. Checked against the row we already read, so the
   * common case costs nothing and the write happens only when it actually drifted.
   *
   * Display name and photo are deliberately NOT synced: those are ours to own once the user
   * has edited their profile, and re-syncing would silently undo their edit on every cache miss.
   */
  private async reconcile(
    record: IAuthUserRecord,
    decoded: DecodedIdToken,
  ): Promise<IAuthUserRecord> {
    const tokenEmail = normalizeEmail(decoded.email);
    if (tokenEmail === record.email) return record;

    this.logger.log({ event: 'identity.email_synced', userId: record.id });
    return this.authUsers.syncEmail(record.firebaseUid, tokenEmail);
  }

  private async readCache(firebaseUid: string): Promise<CachedIdentity | null> {
    try {
      const raw = await this.redis.get(cacheKey(firebaseUid));
      return raw ? (JSON.parse(raw) as CachedIdentity) : null;
    } catch (err) {
      // Fail OPEN to Postgres, never closed to a 401 — a Redis blip must not log everyone out.
      this.logger.warn(`Identity cache read failed: ${asMessage(err)}`);
      return null;
    }
  }

  private async writeCache(record: IAuthUserRecord): Promise<void> {
    const payload: CachedIdentity = {
      id: record.id,
      firebaseUid: record.firebaseUid,
      role: record.role,
      authProvider: record.authProvider,
      email: record.email,
      displayName: record.displayName,
      onboardedAt: record.onboardedAt ? record.onboardedAt.toISOString() : null,
    };

    try {
      await this.redis.set(
        cacheKey(record.firebaseUid),
        JSON.stringify(payload),
        'EX',
        this.cacheTtlSeconds,
      );
    } catch (err) {
      this.logger.warn(`Identity cache write failed: ${asMessage(err)}`);
    }
  }
}

const cacheKey = (firebaseUid: string): string => `identity:uid:${firebaseUid}`;

const asMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Lowercased and trimmed so `ADMIN_BOOTSTRAP_EMAILS` and support lookups match reliably. */
const normalizeEmail = (email: unknown): string | null =>
  typeof email === 'string' && email.trim().length > 0 ? email.trim().toLowerCase() : null;

const toAuthenticated = (record: IAuthUserRecord): AuthenticatedUser => ({
  id: record.id,
  firebaseUid: record.firebaseUid,
  role: record.role,
  authProvider: record.authProvider,
  email: record.email,
  displayName: record.displayName,
  onboardedAt: record.onboardedAt,
});

const fromCache = (cached: CachedIdentity): AuthenticatedUser => ({
  id: cached.id,
  firebaseUid: cached.firebaseUid,
  role: cached.role,
  authProvider: cached.authProvider,
  email: cached.email,
  displayName: cached.displayName,
  onboardedAt: cached.onboardedAt ? new Date(cached.onboardedAt) : null,
});
