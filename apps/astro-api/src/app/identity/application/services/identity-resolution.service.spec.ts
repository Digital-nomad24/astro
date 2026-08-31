import { ConfigService } from '@nestjs/config';
import { UnauthorizedError } from '@astro/errors';
import type { DecodedIdToken } from 'firebase-admin/auth';

import type { IAuthUserRecord, IAuthUserRepo } from '../../domain/repos/auth-user.repo.interface';
import type { FirebaseService } from '../../infra/firebase/firebase.service';
import { IdentityResolutionService } from './identity-resolution.service';

const RECORD: IAuthUserRecord = {
  id: 'usr_1',
  firebaseUid: 'uid_1',
  role: 'USER',
  authProvider: 'EMAIL_PASSWORD',
  email: 'a@example.com',
  phoneNumber: null,
  displayName: 'A',
  photoUrl: null,
  onboardedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const token = (over: Partial<DecodedIdToken> = {}): DecodedIdToken =>
  ({
    uid: 'uid_1',
    email: 'a@example.com',
    firebase: { sign_in_provider: 'password', identities: {} },
    ...over,
  }) as DecodedIdToken;

describe('IdentityResolutionService', () => {
  let repo: jest.Mocked<IAuthUserRepo>;
  let redis: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
  let firebase: { verifyIdToken: jest.Mock };
  let service: IdentityResolutionService;

  beforeEach(() => {
    repo = {
      findByFirebaseUid: jest.fn(),
      provision: jest.fn(),
      syncEmail: jest.fn(),
      updateProfile: jest.fn(),
      markOnboarded: jest.fn(),
    };
    redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn(), del: jest.fn() };
    firebase = { verifyIdToken: jest.fn() };

    service = new IdentityResolutionService(
      repo,
      redis as never,
      firebase as unknown as FirebaseService,
      new ConfigService({ IDENTITY_CACHE_TTL_S: 300 }) as never,
    );
  });

  describe('provisioning', () => {
    it('creates the shadow row the first time a token is seen', async () => {
      repo.findByFirebaseUid.mockResolvedValue(null);
      repo.provision.mockResolvedValue(RECORD);

      const user = await service.resolve(token());

      expect(repo.provision).toHaveBeenCalledWith(
        expect.objectContaining({ firebaseUid: 'uid_1', authProvider: 'EMAIL_PASSWORD' }),
      );
      expect(user.id).toBe('usr_1');
    });

    it.each([
      ['password', 'EMAIL_PASSWORD'],
      ['google.com', 'GOOGLE'],
      ['phone', 'PHONE'],
      ['apple.com', 'OTHER'],
    ])('records %s sign-in as %s through the same path', async (provider, expected) => {
      repo.findByFirebaseUid.mockResolvedValue(null);
      repo.provision.mockResolvedValue({ ...RECORD, authProvider: expected as never });

      await service.resolve(token({ firebase: { sign_in_provider: provider, identities: {} } }));

      expect(repo.provision).toHaveBeenCalledWith(
        expect.objectContaining({ authProvider: expected }),
      );
    });

    it('lowercases the email so bootstrap and support lookups match', async () => {
      repo.findByFirebaseUid.mockResolvedValue(null);
      repo.provision.mockResolvedValue(RECORD);

      await service.resolve(token({ email: '  MiXeD@Example.COM ' }));

      expect(repo.provision).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'mixed@example.com' }),
      );
    });
  });

  describe('caching', () => {
    it('serves a cache hit without touching Postgres', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify({
          id: 'usr_1',
          firebaseUid: 'uid_1',
          role: 'ADMIN',
          authProvider: 'GOOGLE',
          email: 'a@example.com',
          displayName: 'A',
          onboardedAt: '2026-01-02T00:00:00.000Z',
        }),
      );

      const user = await service.resolve(token());

      expect(repo.findByFirebaseUid).not.toHaveBeenCalled();
      expect(user.role).toBe('ADMIN');
      expect(user.onboardedAt).toEqual(new Date('2026-01-02T00:00:00.000Z'));
    });

    it('writes the entry back with a TTL after a miss', async () => {
      repo.findByFirebaseUid.mockResolvedValue(RECORD);

      await service.resolve(token());

      expect(redis.set).toHaveBeenCalledWith('identity:uid:uid_1', expect.any(String), 'EX', 300);
    });

    // A Redis outage must degrade to a slower request, never to a 401 for every user.
    it('falls back to Postgres when the cache read fails', async () => {
      redis.get.mockRejectedValue(new Error('redis down'));
      repo.findByFirebaseUid.mockResolvedValue(RECORD);

      const user = await service.resolve(token());

      expect(user.id).toBe('usr_1');
    });

    it('still resolves when the cache write fails', async () => {
      redis.set.mockRejectedValue(new Error('redis down'));
      repo.findByFirebaseUid.mockResolvedValue(RECORD);

      await expect(service.resolve(token())).resolves.toMatchObject({ id: 'usr_1' });
    });
  });

  describe('email reconciliation', () => {
    it('writes nothing when the email is unchanged', async () => {
      repo.findByFirebaseUid.mockResolvedValue(RECORD);

      await service.resolve(token());

      expect(repo.syncEmail).not.toHaveBeenCalled();
    });

    it('syncs when Firebase reports a different email', async () => {
      repo.findByFirebaseUid.mockResolvedValue(RECORD);
      repo.syncEmail.mockResolvedValue({ ...RECORD, email: 'new@example.com' });

      const user = await service.resolve(token({ email: 'new@example.com' }));

      expect(repo.syncEmail).toHaveBeenCalledWith('uid_1', 'new@example.com');
      expect(user.email).toBe('new@example.com');
    });
  });

  describe('authenticate', () => {
    it('rejects an unverifiable token without disclosing the reason', async () => {
      firebase.verifyIdToken.mockRejectedValue(new Error('Firebase ID token has expired'));

      await expect(service.authenticate('bad')).rejects.toBeInstanceOf(UnauthorizedError);
      await expect(service.authenticate('bad')).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
        message: 'Invalid or expired token',
        httpStatus: 401,
      });
    });

    it('resolves a verified token to the Postgres identity', async () => {
      firebase.verifyIdToken.mockResolvedValue(token());
      repo.findByFirebaseUid.mockResolvedValue(RECORD);

      await expect(service.authenticate('good')).resolves.toMatchObject({ id: 'usr_1' });
    });
  });
});
