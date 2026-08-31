import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import * as request from 'supertest';

import { AppModule } from '../src/app/app.module';
import { IdentityResolutionService } from '../src/app/identity/application/services/identity-resolution.service';
import { PresenceService } from '../src/app/presence/application/services/presence.service';
import { QueueReconcilerScheduler } from '../src/app/queue/application/schedulers/queue-reconciler.scheduler';
import { QueueSweeperScheduler } from '../src/app/queue/application/schedulers/queue-sweeper.scheduler';
import { QueueService } from '../src/app/queue/application/services/queue.service';
import { REDIS_CLIENT } from '../src/app/infra/redis/redis.tokens';
import { RedisIoAdapter } from '../src/config/redis-io.adapter';
import { PrismaService } from '../prisma/prisma.service';
import { cleanupTestUsers, createTestUser, type TestUser } from './firebase-test-user';

/**
 * The per-mentor waiting line, across two instances sharing one Redis.
 *
 * Three properties are worth the setup cost, and none of them is testable against mocks:
 *
 *   - **Exactly one promotion wins.** Two instances dispatch the same free mentor
 *     simultaneously; `session_one_inflight_per_mentor` decides, and the loser goes back at
 *     its original score rather than to the end of the line.
 *   - **A `FLUSHDB` does not lose the queue.** Redis holds the ordering, Postgres holds the
 *     record, and the reconciler rebuilds one from the other at the original positions.
 *   - **Voice and text queue together**, because a mentor takes one session at a time
 *     whichever mode it is.
 */
describe('mentor queue', () => {
  const apps: INestApplication[] = [];
  const sockets: Socket[] = [];

  let mentor: TestUser;
  let mentorProfileId: string;
  let mentorUserId: string;
  const callers: TestUser[] = [];
  const callerUserIds: string[] = [];

  const authFor = (user: TestUser) => ({ Authorization: `Bearer ${user.idToken}` });
  const httpOf = (app: INestApplication) => app.getHttpServer();
  const prismaOf = () => apps[0].get(PrismaService);
  const redisOf = () => apps[0].get<Redis>(REDIS_CLIENT);

  const boot = async (): Promise<INestApplication> => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    const adapter = new RedisIoAdapter(app, app.get<Redis>(REDIS_CLIENT));
    await adapter.connect();
    app.useWebSocketAdapter(adapter);

    await app.init();
    await app.listen(0);
    apps.push(app);
    return app;
  };

  const connectCalls = async (app: INestApplication, user: TestUser): Promise<Socket> => {
    const url = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    const socket = io(`${url}/calls`, {
      auth: { token: user.idToken },
      transports: ['websocket'],
      forceNew: true,
    });
    sockets.push(socket);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('calls:ready timed out')), 15_000);
      socket.on('calls:ready', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.on('connect_error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return socket;
  };

  const nextEvent = <T>(socket: Socket, event: string, timeoutMs = 20_000): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no ${event} within ${timeoutMs}ms`)),
        timeoutMs,
      );
      socket.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

  const bringMentorOnline = () => apps[0].get(PresenceService).goOnline(mentorUserId, true);

  const startSession = async (caller: TestUser, mode: 'VOICE' | 'TEXT', expected = 201) =>
    request(httpOf(apps[0]))
      .post('/sessions')
      .set(authFor(caller))
      .send({ mentorProfileId, mode })
      .expect(expected);

  /** Wipes every session and queue entry for this mentor, in both stores. */
  const resetQueue = async (): Promise<void> => {
    await prismaOf().queueEntry.deleteMany({ where: { mentorProfileId } });
    await prismaOf().session.deleteMany({ where: { mentorProfileId } });
    await redisOf().del(`queue:mentor:${mentorProfileId}`);
    await redisOf().del(`queue:dispatch:${mentorProfileId}`);
    await redisOf().del(`queue:offline:${mentorProfileId}`);
  };

  beforeAll(async () => {
    const [instanceA] = await Promise.all([boot(), boot()]);
    const http = httpOf(instanceA);

    mentor = await createTestUser('queue-mentor');
    for (const label of ['queue-a', 'queue-b', 'queue-c']) {
      callers.push(await createTestUser(label));
    }

    for (const user of [mentor, ...callers]) {
      await request(http).get('/me').set(authFor(user)).expect(200);
      await request(http)
        .patch('/me')
        .set(authFor(user))
        .send({ displayName: `Q ${user.uid.slice(0, 6)}` })
        .expect(200);
    }

    const application = await request(http)
      .post('/mentors/apply')
      .set(authFor(mentor))
      .send({
        categorySlug: 'astrology',
        displayName: 'Queue Mentor',
        languages: ['English'],
        experienceYears: 6,
        ratePaisePerMinute: 1800,
      })
      .expect(201);

    mentorProfileId = application.body.id;

    const prisma = instanceA.get(PrismaService);
    await prisma.mentorProfile.update({
      where: { id: mentorProfileId },
      data: { approvalStatus: 'APPROVED', approvedAt: new Date() },
    });
    await instanceA.get(IdentityResolutionService).invalidate(mentor.uid);

    const mentorRow = await prisma.user.findUnique({ where: { firebaseUid: mentor.uid } });
    mentorUserId = mentorRow?.id ?? '';
    for (const caller of callers) {
      const row = await prisma.user.findUnique({ where: { firebaseUid: caller.uid } });
      callerUserIds.push(row?.id ?? '');
    }
  }, 240_000);

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();

    const prisma = apps[0]?.get(PrismaService);
    if (prisma) {
      await prisma.queueEntry.deleteMany({ where: { mentorProfileId } }).catch(() => undefined);
      await prisma.session.deleteMany({ where: { mentorProfileId } }).catch(() => undefined);
      await prisma.user
        .deleteMany({
          where: { firebaseUid: { in: [mentor?.uid, ...callers.map((c) => c.uid)] } },
        })
        .catch(() => undefined);
    }
    await redisOf()
      .del(`queue:mentor:${mentorProfileId}`)
      .catch(() => undefined);

    await cleanupTestUsers();
    for (const app of apps) {
      await app.close().catch(() => undefined);
    }
  }, 60_000);

  beforeEach(async () => {
    await resetQueue();
    await bringMentorOnline();
  }, 60_000);

  describe('joining the line', () => {
    it('rings the first caller straight through and queues the rest', async () => {
      const first = await startSession(callers[0], 'VOICE');
      expect(first.body.session.status).toBe('RINGING');
      expect(first.body.queue).toBeNull();

      // Mentor is now BUSY-bound (RINGING occupies the in-flight slot), so the next two wait.
      const second = await startSession(callers[1], 'TEXT');
      expect(second.body.session.status).toBe('QUEUED');
      expect(second.body.queue).toMatchObject({ position: 1, queueDepth: 1 });
      // A queued voice call gets no room and no token — a room held open for a half-hour wait
      // is a billable resource nobody is in.
      expect(second.body.credentials).toBeNull();

      const third = await startSession(callers[2], 'VOICE');
      expect(third.body.queue).toMatchObject({ position: 2, queueDepth: 2 });
      // Voice and text queue TOGETHER: a mentor takes one session at a time whichever mode
      // it is, so two queues would only let a text request jump a voice one.
      expect(second.body.session.mode).toBe('TEXT');
      expect(third.body.session.mode).toBe('VOICE');
    }, 120_000);

    it('queues even a free mentor when someone is already waiting', async () => {
      await startSession(callers[0], 'VOICE');
      await startSession(callers[1], 'VOICE');

      // End the ringing session so the mentor is momentarily free, but WITHOUT letting the
      // dispatcher run — the queue is still non-empty.
      const ringing = await prismaOf().session.findFirst({
        where: { mentorProfileId, status: 'RINGING' },
      });
      await prismaOf().session.update({
        where: { id: ringing?.id ?? '' },
        data: { status: 'CANCELLED', endedAt: new Date(), endReason: 'CANCELLED_BY_USER' },
      });

      const late = await startSession(callers[2], 'VOICE');
      // Fairness: without the depth check, an arrival at an idle moment would be rung straight
      // through past someone who has been waiting.
      expect(late.body.session.status).toBe('QUEUED');
      expect(late.body.queue.position).toBe(2);
    }, 120_000);

    it('refuses a second session for a caller already waiting', async () => {
      await startSession(callers[0], 'VOICE');
      await startSession(callers[1], 'VOICE');

      // `session_one_inflight_per_user` now covers QUEUED — one place in one line, not one
      // place in every line.
      const again = await startSession(callers[1], 'TEXT', 409);
      expect(['SESSION_ALREADY_IN_FLIGHT', 'MENTOR_BUSY']).toContain(again.body.code);
    }, 120_000);

    it('records a durable entry alongside the Redis place', async () => {
      await startSession(callers[0], 'VOICE');
      const queued = await startSession(callers[1], 'TEXT');
      const sessionId = queued.body.session.id;

      const entry = await prismaOf().queueEntry.findUnique({ where: { sessionId } });
      expect(entry).toMatchObject({ status: 'WAITING', mentorProfileId, mode: 'TEXT' });
      // The score IS the enqueue time. That equality is what makes the reconciler's rebuild
      // land everyone back where they were.
      const score = await redisOf().zscore(`queue:mentor:${mentorProfileId}`, sessionId);
      expect(Number(score)).toBe(entry?.enqueuedAt.getTime());
    }, 120_000);
  });

  describe('dispatch', () => {
    it('promotes exactly one waiting user when the mentor frees up', async () => {
      const ringing = await startSession(callers[0], 'VOICE');
      const queuedB = await startSession(callers[1], 'VOICE');
      const queuedC = await startSession(callers[2], 'VOICE');

      await request(httpOf(apps[0]))
        .post(`/sessions/${ringing.body.session.id}/decline`)
        .set(authFor(mentor))
        .expect(200);

      await settle(2500);

      const b = await prismaOf().session.findUnique({
        where: { id: queuedB.body.session.id },
      });
      const c = await prismaOf().session.findUnique({
        where: { id: queuedC.body.session.id },
      });

      // FIFO: B was first in, so B is first out. C stays put.
      expect(b?.status).toBe('RINGING');
      expect(c?.status).toBe('QUEUED');

      const entry = await prismaOf().queueEntry.findUnique({
        where: { sessionId: queuedB.body.session.id },
      });
      expect(entry).toMatchObject({ status: 'PROMOTED', leaveReason: 'PROMOTED' });
      expect(entry?.promotedAt).not.toBeNull();
    }, 180_000);

    it('produces exactly one RINGING when two instances dispatch at once', async () => {
      await startSession(callers[0], 'VOICE');
      await startSession(callers[1], 'VOICE');
      await startSession(callers[2], 'VOICE');

      // Free the mentor without triggering dispatch, so both instances start from a clean
      // race rather than one of them having already won.
      const ringing = await prismaOf().session.findFirst({
        where: { mentorProfileId, status: 'RINGING' },
      });
      await prismaOf().session.update({
        where: { id: ringing?.id ?? '' },
        data: { status: 'CANCELLED', endedAt: new Date(), endReason: 'CANCELLED_BY_USER' },
      });

      // Hammer it from both processes at once. The Lua dispatch lock makes a collision rare;
      // `session_one_inflight_per_mentor` is what makes losing one harmless.
      await Promise.all([
        apps[0].get(QueueService).dispatchNext(mentorProfileId),
        apps[1].get(QueueService).dispatchNext(mentorProfileId),
        apps[0].get(QueueService).dispatchNext(mentorProfileId),
        apps[1].get(QueueService).dispatchNext(mentorProfileId),
      ]);

      const stillRinging = await prismaOf().session.count({
        where: { mentorProfileId, status: 'RINGING' },
      });
      expect(stillRinging).toBe(1);

      // And the loser kept their place rather than being dropped or sent to the back.
      const waiting = await prismaOf().queueEntry.count({
        where: { mentorProfileId, status: 'WAITING' },
      });
      const depth = await redisOf().zcard(`queue:mentor:${mentorProfileId}`);
      expect(waiting).toBe(1);
      expect(depth).toBe(1);
    }, 180_000);

    it('pushes the new position to everyone still waiting', async () => {
      const ringing = await startSession(callers[0], 'VOICE');
      await startSession(callers[1], 'VOICE');

      const socketC = await connectCalls(apps[1], callers[2]);
      const queuedC = await startSession(callers[2], 'VOICE');
      expect(queuedC.body.queue.position).toBe(2);

      const moved = nextEvent<{ position: number }>(socketC, 'queue:position');

      await request(httpOf(apps[0]))
        .post(`/sessions/${ringing.body.session.id}/decline`)
        .set(authFor(mentor))
        .expect(200);

      // C was second; B's promotion moves C to first. Cross-instance: C is on instance B.
      await expect(moved).resolves.toMatchObject({ position: 1 });
    }, 180_000);

    it('returns the caller to their place on calls:resync', async () => {
      await startSession(callers[0], 'VOICE');
      const queued = await startSession(callers[1], 'VOICE');

      const socket = await connectCalls(apps[1], callers[1]);
      const ack = await new Promise<{
        ok: boolean;
        session: { id: string; status: string } | null;
        queue: { position: number } | null;
      }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('resync timed out')), 20_000);
        socket.emit('calls:resync', {}, (result: never) => {
          clearTimeout(timer);
          resolve(result);
        });
      });

      expect(ack.ok).toBe(true);
      expect(ack.session?.id).toBe(queued.body.session.id);
      expect(ack.session?.status).toBe('QUEUED');
      // Recovery is one round trip, not "wait for the next person to leave".
      expect(ack.queue?.position).toBe(1);
    }, 180_000);
  });

  describe('abandonment', () => {
    it('expires an entry past the hard TTL and tells the caller why', async () => {
      await startSession(callers[0], 'VOICE');
      const queued = await startSession(callers[1], 'VOICE');
      const sessionId: string = queued.body.session.id;

      const socket = await connectCalls(apps[0], callers[1]);
      const left = nextEvent<{ sessionId: string; reason: string }>(socket, 'queue:left');

      // Back-date rather than wait out QUEUE_ENTRY_TTL_S. The cutoff arithmetic is under
      // test, not the wall clock.
      await prismaOf().queueEntry.update({
        where: { sessionId },
        data: { enqueuedAt: new Date(Date.now() - 60 * 60 * 1000) },
      });

      await apps[0].get(QueueSweeperScheduler).sweep();

      await expect(left).resolves.toMatchObject({ sessionId, reason: 'TTL_EXPIRED' });

      const entry = await prismaOf().queueEntry.findUnique({ where: { sessionId } });
      const session = await prismaOf().session.findUnique({ where: { id: sessionId } });
      expect(entry).toMatchObject({ status: 'EXPIRED', leaveReason: 'TTL_EXPIRED' });
      // The session's own end reason explains itself without a join back to the queue.
      expect(session).toMatchObject({ status: 'CANCELLED', endReason: 'QUEUE_EXPIRED' });
    }, 180_000);

    it('holds a place through a brief disconnect and drops it after the grace', async () => {
      await startSession(callers[0], 'VOICE');
      const queued = await startSession(callers[1], 'VOICE');
      const sessionId: string = queued.body.session.id;

      await apps[0].get(QueueService).onUserDisconnected(callerUserIds[1]);
      await apps[0].get(QueueSweeperScheduler).sweep();

      // Inside the grace. Backgrounding a mobile app produces exactly this, and dissolving a
      // place for it would make the queue unusable on a phone.
      expect((await prismaOf().queueEntry.findUnique({ where: { sessionId } }))?.status).toBe(
        'WAITING',
      );

      // Reconnecting clears the timer entirely.
      await apps[0].get(QueueService).onUserConnected(callerUserIds[1]);
      expect(
        (await prismaOf().queueEntry.findUnique({ where: { sessionId } }))?.disconnectedAt,
      ).toBeNull();

      // Now age the disconnect past QUEUE_DISCONNECT_GRACE_S.
      await prismaOf().queueEntry.update({
        where: { sessionId },
        data: { disconnectedAt: new Date(Date.now() - 10 * 60 * 1000) },
      });
      await apps[0].get(QueueSweeperScheduler).sweep();

      expect((await prismaOf().queueEntry.findUnique({ where: { sessionId } }))?.status).toBe(
        'EXPIRED',
      );
    }, 180_000);

    it('holds the whole queue while a mentor is briefly offline, then dissolves it', async () => {
      await startSession(callers[0], 'VOICE');
      const queued = await startSession(callers[1], 'VOICE');
      const sessionId: string = queued.body.session.id;

      await apps[0].get(PresenceService).goOffline(mentorUserId);

      // First tick only starts the clock. A mentor switching from wifi to mobile data must not
      // cost twenty people their places.
      await apps[0].get(QueueSweeperScheduler).sweep();
      expect((await prismaOf().queueEntry.findUnique({ where: { sessionId } }))?.status).toBe(
        'WAITING',
      );

      // Age the hold past QUEUE_MENTOR_OFFLINE_GRACE_S.
      await redisOf().set(`queue:offline:${mentorProfileId}`, String(Date.now() - 10 * 60 * 1000));
      await apps[0].get(QueueSweeperScheduler).sweep();

      const entry = await prismaOf().queueEntry.findUnique({ where: { sessionId } });
      const session = await prismaOf().session.findUnique({ where: { id: sessionId } });
      expect(entry).toMatchObject({ status: 'EXPIRED', leaveReason: 'MENTOR_OFFLINE' });
      expect(session?.endReason).toBe('MENTOR_OFFLINE');
    }, 180_000);
  });

  describe('the reconciler', () => {
    it('rebuilds a flushed queue at everyone original positions', async () => {
      await startSession(callers[0], 'VOICE');
      const b = await startSession(callers[1], 'VOICE');
      const c = await startSession(callers[2], 'VOICE');

      const key = `queue:mentor:${mentorProfileId}`;
      const before = await redisOf().zrange(key, 0, -1);
      expect(before).toEqual([b.body.session.id, c.body.session.id]);

      // The scenario this job exists for. Not a contrived one: an eviction, a restart, or a
      // provider incident all look exactly like this.
      await redisOf().del(key);
      expect(await redisOf().zcard(key)).toBe(0);

      await apps[1].get(QueueReconcilerScheduler).reconcile();

      const after = await redisOf().zrange(key, 0, -1);
      // Same members, same ORDER. Rebuilding in arbitrary order would silently reshuffle the
      // line and nobody could tell it had happened.
      expect(after).toEqual(before);

      const scoreB = await redisOf().zscore(key, b.body.session.id);
      const entryB = await prismaOf().queueEntry.findUnique({
        where: { sessionId: b.body.session.id },
      });
      expect(Number(scoreB)).toBe(entryB?.enqueuedAt.getTime());
    }, 180_000);

    it('drops an orphan member whose entry is no longer waiting', async () => {
      await startSession(callers[0], 'VOICE');
      const queued = await startSession(callers[1], 'VOICE');
      const key = `queue:mentor:${mentorProfileId}`;

      // Exactly what a promotion that crashed between popping and settling leaves behind.
      await redisOf().zadd(key, Date.now(), 'ses_orphan_does_not_exist');
      expect(await redisOf().zcard(key)).toBe(2);

      await apps[0].get(QueueReconcilerScheduler).reconcile();

      const after = await redisOf().zrange(key, 0, -1);
      // The dispatcher would otherwise promote a session that does not exist, and burn a
      // dispatch round doing it.
      expect(after).toEqual([queued.body.session.id]);
    }, 180_000);
  });
});

const settle = (ms = 1500): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
