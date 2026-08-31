import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import * as request from 'supertest';

import { AppModule } from '../src/app/app.module';
import { RedisIoAdapter } from '../src/config/redis-io.adapter';
import { IdentityResolutionService } from '../src/app/identity/application/services/identity-resolution.service';
import { REDIS_CLIENT } from '../src/app/infra/redis/redis.tokens';
import { PrismaService } from '../prisma/prisma.service';
import { cleanupTestUsers, createTestUser, type TestUser } from './firebase-test-user';

/**
 * Presence, across TWO running instances sharing one Redis.
 *
 * The single-instance version of this test would pass with the stock in-memory adapter and
 * prove nothing — the whole point of the design is that a mentor connecting to instance A is
 * visible to a browser connected to instance B. So both apps are booted with the real
 * `RedisIoAdapter`, exactly as `main.ts` does.
 */
describe('presence across instances', () => {
  const apps: INestApplication[] = [];
  const sockets: Socket[] = [];

  let mentorUser: TestUser;
  let consumerUser: TestUser;
  let mentorProfileId: string;
  let categorySlug: string;

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
    await app.listen(0); // ephemeral port
    apps.push(app);
    return app;
  };

  const urlOf = async (app: INestApplication): Promise<string> => {
    const raw = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    return raw;
  };

  const connect = async (url: string, user: TestUser): Promise<Socket> => {
    const socket = io(`${url}/presence`, {
      auth: { token: user.idToken },
      transports: ['websocket'],
      forceNew: true,
    });
    sockets.push(socket);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('presence:ready timed out')), 15_000);
      // Waiting for `presence:ready`, not `connect`: the socket exists before the server has
      // resolved the identity, and acting in that window is the race the handshake removes.
      socket.on('presence:ready', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.on('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    return socket;
  };

  const emit = <T>(socket: Socket, event: string, payload: unknown): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${event} ack timed out`)), 15_000);
      socket.emit(event, payload, (ack: T) => {
        clearTimeout(timer);
        resolve(ack);
      });
    });

  /**
   * Waits for the next matching event, skipping ones that are not about this test's mentor.
   *
   * The subscription includes a CATEGORY room, and every suite in this project seeds its
   * mentors into `astrology` — so a presence change for someone else's mentor legitimately
   * arrives on the same room. Taking the first event regardless would make this suite fail
   * whenever another one happened to flip a mentor at the same moment, which looks like a
   * cluster-fan-out bug and is not one.
   */
  const nextEvent = <T>(
    socket: Socket,
    event: string,
    matches: (payload: T) => boolean = () => true,
    timeoutMs = 10_000,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off(event, onEvent);
        reject(new Error(`no matching ${event} within ${timeoutMs}ms`));
      }, timeoutMs);

      const onEvent = (payload: T): void => {
        if (!matches(payload)) return;
        clearTimeout(timer);
        socket.off(event, onEvent);
        resolve(payload);
      };
      socket.on(event, onEvent);
    });

  /** Only events about the mentor this suite owns. */
  const forOurMentor = (payload: { mentorProfileId: string }): boolean =>
    payload.mentorProfileId === mentorProfileId;

  beforeAll(async () => {
    const [instanceA] = await Promise.all([boot(), boot()]);

    [mentorUser, consumerUser] = await Promise.all([
      createTestUser('presence-mentor'),
      createTestUser('presence-consumer'),
    ]);

    const http = instanceA.getHttpServer();
    const authHeader = (user: TestUser) => ({ Authorization: `Bearer ${user.idToken}` });

    for (const user of [mentorUser, consumerUser]) {
      await request(http).get('/me').set(authHeader(user)).expect(200);
    }

    // Onboard, apply, then approve — a mentor must be APPROVED before presence will let them
    // announce, which is one of the behaviours under test.
    await request(http)
      .patch('/me')
      .set(authHeader(mentorUser))
      .send({ displayName: 'Presence Mentor' })
      .expect(200);

    const application = await request(http)
      .post('/mentors/apply')
      .set(authHeader(mentorUser))
      .send({
        categorySlug: 'astrology',
        displayName: 'Presence Mentor',
        languages: ['English'],
        experienceYears: 3,
        ratePaisePerMinute: 1500,
      })
      .expect(201);

    mentorProfileId = application.body.id;
    categorySlug = application.body.categorySlug;

    const prisma = instanceA.get(PrismaService);
    await prisma.mentorProfile.update({
      where: { id: mentorProfileId },
      data: { approvalStatus: 'APPROVED', approvedAt: new Date() },
    });
    await instanceA.get(IdentityResolutionService).invalidate(mentorUser.uid);
  }, 180_000);

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();

    const prisma = apps[0]?.get(PrismaService);
    await prisma?.user
      .deleteMany({ where: { firebaseUid: { in: [mentorUser?.uid, consumerUser?.uid] } } })
      .catch(() => undefined);

    await cleanupTestUsers();
    // Sequentially, and tolerantly: each app owns its own Redis client and socket server, and
    // a close that races an in-flight cron tick should not fail the run.
    for (const app of apps) {
      await app.close().catch(() => undefined);
    }
  }, 60_000);

  it('rejects a handshake with no token', async () => {
    const url = await urlOf(apps[0]);
    const socket = io(`${url}/presence`, { transports: ['websocket'], forceNew: true });
    sockets.push(socket);

    await expect(
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('still connected')), 10_000);
        socket.on('disconnect', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.on('presence:ready', () => {
          clearTimeout(timer);
          reject(new Error('unauthenticated socket got presence:ready'));
        });
      }),
    ).resolves.toBeUndefined();
  }, 30_000);

  it('propagates a mentor going online on instance A to a subscriber on instance B', async () => {
    const [urlA, urlB] = await Promise.all([urlOf(apps[0]), urlOf(apps[1])]);
    const mentorSocket = await connect(urlA, mentorUser);
    const consumerSocket = await connect(urlB, consumerUser);

    const subscribed = await emit<{ ok: boolean }>(consumerSocket, 'presence:subscribe', {
      categorySlugs: [categorySlug],
      mentorProfileIds: [mentorProfileId],
    });
    expect(subscribed.ok).toBe(true);

    const changed = nextEvent<{ mentorProfileId: string; state: string }>(
      consumerSocket,
      'presence:changed',
      forOurMentor,
    );

    const ack = await emit<{ ok: boolean; state?: string }>(mentorSocket, 'mentor:go-online', {});
    expect(ack).toMatchObject({ ok: true, state: 'ONLINE' });

    // This is the assertion the whole design exists for. It fails with the default in-memory
    // adapter, because the emit never leaves instance A.
    await expect(changed).resolves.toMatchObject({ mentorProfileId, state: 'ONLINE' });
  }, 60_000);

  it('returns the current snapshot in the subscribe ack, so no priming REST call is needed', async () => {
    const urlB = await urlOf(apps[1]);
    const socket = await connect(urlB, consumerUser);

    const ack = await emit<{ ok: boolean; snapshot: { mentorProfileId: string; state: string }[] }>(
      socket,
      'presence:subscribe',
      { mentorProfileIds: [mentorProfileId] },
    );

    expect(ack.ok).toBe(true);
    expect(ack.snapshot).toEqual([expect.objectContaining({ mentorProfileId, state: 'ONLINE' })]);
  }, 60_000);

  it('propagates set-accepting and go-offline across instances', async () => {
    const [urlA, urlB] = await Promise.all([urlOf(apps[0]), urlOf(apps[1])]);
    const mentorSocket = await connect(urlA, mentorUser);
    const consumerSocket = await connect(urlB, consumerUser);
    await emit(consumerSocket, 'presence:subscribe', { mentorProfileIds: [mentorProfileId] });

    const closed = nextEvent<{ mentorProfileId: string; acceptingNewCalls: boolean }>(
      consumerSocket,
      'presence:changed',
      forOurMentor,
    );
    await emit(mentorSocket, 'mentor:set-accepting', { accepting: false });
    await expect(closed).resolves.toMatchObject({ state: 'ONLINE', acceptingNewCalls: false });

    const offline = nextEvent<{ mentorProfileId: string; state: string }>(
      consumerSocket,
      'presence:changed',
      forOurMentor,
    );
    await emit(mentorSocket, 'mentor:go-offline', {});
    await expect(offline).resolves.toMatchObject({ mentorProfileId, state: 'OFFLINE' });
  }, 60_000);

  it('refuses to put a non-mentor online', async () => {
    const urlA = await urlOf(apps[0]);
    const socket = await connect(urlA, consumerUser);

    const ack = await emit<{ ok: boolean; error?: string }>(socket, 'mentor:go-online', {});
    expect(ack).toMatchObject({ ok: false, error: 'not_a_mentor' });
  }, 60_000);

  it('tells an offline mentor to re-announce rather than heartbeating a lapsed record', async () => {
    const urlA = await urlOf(apps[0]);
    const mentorSocket = await connect(urlA, mentorUser);

    // The mentor went offline in an earlier test, so the Redis record is gone.
    const ack = await emit<{ ok: boolean; error?: string }>(mentorSocket, 'presence:heartbeat', {});
    expect(ack).toMatchObject({ ok: false, error: 'not_online' });
  }, 60_000);

  it('rejects an over-long subscription list instead of doing unbounded work', async () => {
    const urlA = await urlOf(apps[0]);
    const socket = await connect(urlA, consumerUser);

    const ack = await emit<{ ok: boolean; error?: string }>(socket, 'presence:subscribe', {
      mentorProfileIds: Array.from({ length: 500 }, (_, i) => `mnt_${i}`),
    });
    // A typed ack, not a dropped callback — an over-long list is something a paging client
    // does routinely, so it has to be recoverable rather than a hang.
    expect(ack).toMatchObject({ ok: false, error: 'too_many_ids' });
  }, 60_000);
});
