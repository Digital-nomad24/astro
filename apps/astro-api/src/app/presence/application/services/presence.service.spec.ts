import { ConfigService } from '@nestjs/config';
import { ForbiddenError, NotFoundError } from '@astro/errors';
import type { MentorPresenceSnapshot } from '@astro/contracts';

import type {
  IMentorProfileRecord,
  IMentorProfileRepo,
} from '../../../mentors/domain/repos/mentor.repos';
import type { IPresenceRepo } from '../../domain/repos/presence.repo.interface';
import { PresenceService } from './presence.service';

const MENTOR = {
  id: 'mnt_1',
  userId: 'usr_1',
  categoryId: 'cat_1',
  categorySlug: 'astrology',
  categoryName: 'Astrology',
  displayName: 'Test Mentor',
  headline: null,
  bio: null,
  languages: ['English'],
  experienceYears: 5,
  ratePaisePerMinute: 2000,
  approvalStatus: 'APPROVED',
  approvalNote: null,
  approvedAt: new Date(),
  presenceState: 'OFFLINE',
  acceptingNewCalls: true,
  queueDepth: 0,
  ratingAvg: 4.5,
  ratingCount: 10,
  ratingSum: 45,
  totalSessions: 20,
  createdAt: new Date(),
} satisfies IMentorProfileRecord;

describe('PresenceService', () => {
  let presenceRepo: jest.Mocked<IPresenceRepo>;
  let mentors: jest.Mocked<
    Pick<IMentorProfileRepo, 'findByUserId' | 'findById' | 'updatePresence'>
  >;
  let broadcast: jest.Mock<void, [MentorPresenceSnapshot]>;
  let service: PresenceService;

  beforeEach(() => {
    presenceRepo = {
      set: jest.fn(),
      touch: jest.fn(),
      get: jest.fn().mockResolvedValue(null),
      getMany: jest.fn().mockResolvedValue([]),
      clear: jest.fn(),
      findStale: jest.fn(),
    };
    mentors = {
      findByUserId: jest.fn().mockResolvedValue(MENTOR),
      findById: jest.fn().mockResolvedValue(MENTOR),
      updatePresence: jest.fn().mockResolvedValue(undefined),
    };
    broadcast = jest.fn();

    service = new PresenceService(
      presenceRepo,
      mentors as unknown as IMentorProfileRepo,
      new ConfigService({ PRESENCE_TTL_S: 45 }) as never,
    );
    service.registerBroadcaster(broadcast);
  });

  describe('goOnline', () => {
    it('writes Redis, syncs the read model, and broadcasts', async () => {
      const snapshot = await service.goOnline('usr_1', true);

      expect(snapshot).toMatchObject({
        mentorProfileId: 'mnt_1',
        categorySlug: 'astrology',
        state: 'ONLINE',
        acceptingNewCalls: true,
        ratePaisePerMinute: 2000,
      });
      expect(presenceRepo.set).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'ONLINE' }),
        45,
      );
      expect(mentors.updatePresence).toHaveBeenCalledWith(
        expect.objectContaining({ mentorProfileId: 'mnt_1', presenceState: 'ONLINE' }),
      );
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ state: 'ONLINE' }));
    });

    // A pushed presence event bypasses the catalogue query's approval filter entirely, so the
    // gate has to be here too — otherwise a suspended mentor appears in every live feed.
    it.each(['PENDING', 'REJECTED', 'SUSPENDED'] as const)(
      'refuses a %s mentor',
      async (approvalStatus) => {
        mentors.findByUserId.mockResolvedValue({ ...MENTOR, approvalStatus });

        await expect(service.goOnline('usr_1', true)).rejects.toBeInstanceOf(ForbiddenError);
        expect(presenceRepo.set).not.toHaveBeenCalled();
        expect(broadcast).not.toHaveBeenCalled();
      },
    );

    it('refuses a user with no mentor profile', async () => {
      mentors.findByUserId.mockResolvedValue(null);
      await expect(service.goOnline('usr_1', true)).rejects.toBeInstanceOf(NotFoundError);
    });

    // Going online must never clear a call in progress.
    it('preserves BUSY rather than downgrading to ONLINE', async () => {
      presenceRepo.get.mockResolvedValue({
        mentorProfileId: 'mnt_1',
        categorySlug: 'astrology',
        state: 'BUSY',
        acceptingNewCalls: false,
        queueDepth: 3,
        ratePaisePerMinute: 2000,
        updatedAtMs: Date.now(),
      });

      const snapshot = await service.goOnline('usr_1', true);
      expect(snapshot.state).toBe('BUSY');
    });

    // The read model is derived; losing it must not fail the transition.
    it('still succeeds when the read-model write fails', async () => {
      mentors.updatePresence.mockRejectedValue(new Error('postgres down'));

      const snapshot = await service.goOnline('usr_1', true);

      expect(snapshot.state).toBe('ONLINE');
      expect(broadcast).toHaveBeenCalled();
    });
  });

  describe('goOffline', () => {
    it('clears Redis and broadcasts OFFLINE', async () => {
      await service.goOffline('usr_1');

      expect(presenceRepo.clear).toHaveBeenCalledWith('mnt_1');
      expect(mentors.updatePresence).toHaveBeenCalledWith(
        expect.objectContaining({ presenceState: 'OFFLINE' }),
      );
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'OFFLINE', acceptingNewCalls: false }),
      );
    });
  });

  describe('setAccepting', () => {
    it('keeps the mentor online but closed to new sessions', async () => {
      presenceRepo.get.mockResolvedValue({
        mentorProfileId: 'mnt_1',
        categorySlug: 'astrology',
        state: 'ONLINE',
        acceptingNewCalls: true,
        queueDepth: 2,
        ratePaisePerMinute: 2000,
        updatedAtMs: Date.now(),
      });

      const snapshot = await service.setAccepting('usr_1', false);

      expect(snapshot).toMatchObject({ state: 'ONLINE', acceptingNewCalls: false, queueDepth: 2 });
    });

    it('refuses when the mentor is not online', async () => {
      presenceRepo.get.mockResolvedValue(null);
      await expect(service.setAccepting('usr_1', false)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('setBusy', () => {
    const online = {
      mentorProfileId: 'mnt_1',
      categorySlug: 'astrology',
      state: 'ONLINE' as const,
      acceptingNewCalls: true,
      queueDepth: 0,
      ratePaisePerMinute: 2000,
      updatedAtMs: Date.now(),
    };

    it('flips ONLINE to BUSY and broadcasts it', async () => {
      presenceRepo.get.mockResolvedValue(online);

      await service.setBusy('mnt_1', true);

      expect(presenceRepo.set).toHaveBeenCalledWith(
        expect.objectContaining({ mentorProfileId: 'mnt_1', state: 'BUSY' }),
        45,
      );
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ state: 'BUSY' }));
    });

    it('releases a BUSY mentor back to ONLINE when the session ends', async () => {
      presenceRepo.get.mockResolvedValue({ ...online, state: 'BUSY' });

      await service.setBusy('mnt_1', false);

      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ state: 'ONLINE' }));
    });

    it('does nothing when the mentor has no live presence record', async () => {
      // Real combination: a mentor can be mid-call while their heartbeat lapses. Creating a
      // record here would resurrect them as ONLINE on every browse page the moment the call
      // ended, without them ever having reconnected. Presence is owned by the mentor's socket.
      presenceRepo.get.mockResolvedValue(null);

      await service.setBusy('mnt_1', false);

      expect(presenceRepo.set).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
    });

    it('is a no-op when the state already matches, so nothing re-broadcasts', async () => {
      presenceRepo.get.mockResolvedValue({ ...online, state: 'BUSY' });

      await service.setBusy('mnt_1', true);

      expect(presenceRepo.set).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
    });

    it('preserves acceptingNewCalls and queueDepth across the flip', async () => {
      presenceRepo.get.mockResolvedValue({ ...online, acceptingNewCalls: false, queueDepth: 3 });

      await service.setBusy('mnt_1', true);

      expect(presenceRepo.set).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'BUSY', acceptingNewCalls: false, queueDepth: 3 }),
        45,
      );
    });
  });

  describe('heartbeat', () => {
    it('reports true while the record is alive', async () => {
      presenceRepo.touch.mockResolvedValue(true);
      await expect(service.heartbeat('usr_1')).resolves.toBe(true);
      expect(presenceRepo.touch).toHaveBeenCalledWith('mnt_1', 45);
    });

    // Signals the client to re-announce rather than heartbeat a record nobody can see.
    it('reports false when the record has already lapsed', async () => {
      presenceRepo.touch.mockResolvedValue(false);
      await expect(service.heartbeat('usr_1')).resolves.toBe(false);
    });
  });
});
