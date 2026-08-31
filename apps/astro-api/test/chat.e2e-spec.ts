import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import * as request from 'supertest';

import { AppModule } from '../src/app/app.module';
import { ChatRetentionScheduler } from '../src/app/chat/application/schedulers/chat-retention.scheduler';
import { ChatIdleScheduler } from '../src/app/chat/application/schedulers/chat-idle.scheduler';
import { IdentityResolutionService } from '../src/app/identity/application/services/identity-resolution.service';
import { PresenceService } from '../src/app/presence/application/services/presence.service';
import { REDIS_CLIENT } from '../src/app/infra/redis/redis.tokens';
import { RedisIoAdapter } from '../src/config/redis-io.adapter';
import { PrismaService } from '../prisma/prisma.service';
import { cleanupTestUsers, createTestUser, type TestUser } from './firebase-test-user';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Text consultations, across TWO instances sharing one Redis.
 *
 * The two participants in a consultation are routinely on different instances, so the
 * single-instance version of the delivery test would pass with the stock in-memory adapter and
 * prove nothing. Everything else here — dedupe, the billing anchor, the retention purge —
 * depends on real Postgres constraints rather than on application logic, so a mocked Prisma
 * would test the mock.
 */
describe('text chat', () => {
  const apps: INestApplication[] = [];
  const sockets: Socket[] = [];

  let caller: TestUser;
  let mentor: TestUser;
  let mentorProfileId: string;
  let mentorUserId: string;
  let callerUserId: string;

  const authFor = (user: TestUser) => ({ Authorization: `Bearer ${user.idToken}` });
  const httpOf = (app: INestApplication) => app.getHttpServer();

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

  const connectChat = async (app: INestApplication, user: TestUser): Promise<Socket> => {
    const url = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    const socket = io(`${url}/chat`, {
      auth: { token: user.idToken },
      transports: ['websocket'],
      forceNew: true,
    });
    sockets.push(socket);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('chat:ready timed out')), 15_000);
      socket.on('chat:ready', () => {
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

  const emit = <T>(socket: Socket, event: string, payload: unknown): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${event} ack timed out`)), 15_000);
      socket.emit(event, payload, (ack: T) => {
        clearTimeout(timer);
        resolve(ack);
      });
    });

  const nextEvent = <T>(socket: Socket, event: string, timeoutMs = 15_000): Promise<T> =>
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

  const prismaOf = () => apps[0].get(PrismaService);

  /** A fresh ACTIVE text session between the two fixtures. */
  const startTextSession = async (): Promise<string> => {
    await apps[0].get(PresenceService).goOnline(mentorUserId, true);

    const created = await request(httpOf(apps[0]))
      .post('/sessions')
      .set(authFor(caller))
      .send({ mentorProfileId, mode: 'TEXT' })
      .expect(201);

    const sessionId: string = created.body.session.id;
    // A text session gets no LiveKit room, no token, no webhook — nothing to join.
    expect(created.body.credentials).toBeNull();

    await request(httpOf(apps[0]))
      .post(`/sessions/${sessionId}/accept`)
      .set(authFor(mentor))
      .expect(200);

    return sessionId;
  };

  /**
   * Shifts an ended session's whole timeline into the past.
   *
   * Every timestamp moves together, not just `endedAt`. `Session_timestamps_ordered` refuses a
   * row that ended before it was created — which is exactly what a naive back-date produces,
   * and is the constraint doing its job: a session with an impossible ordering would compute a
   * negative duration in M10.
   */
  const ageSession = async (sessionId: string, days: number): Promise<void> => {
    const shift = days * DAY_MS;
    const session = await prismaOf().session.findUniqueOrThrow({ where: { id: sessionId } });
    const back = (value: Date | null): Date | null =>
      value ? new Date(value.getTime() - shift) : null;

    await prismaOf().session.update({
      where: { id: sessionId },
      data: {
        createdAt: back(session.createdAt) ?? session.createdAt,
        ringingAt: back(session.ringingAt),
        acceptedAt: back(session.acceptedAt),
        billingAnchorAt: back(session.billingAnchorAt),
        lastMessageAt: back(session.lastMessageAt),
        endedAt: back(session.endedAt),
      },
    });
  };

  const endSession = async (sessionId: string): Promise<void> => {
    await request(httpOf(apps[0]))
      .post(`/sessions/${sessionId}/end`)
      .set(authFor(caller))
      .catch(() => undefined);
  };

  beforeAll(async () => {
    const [instanceA] = await Promise.all([boot(), boot()]);

    [caller, mentor] = await Promise.all([
      createTestUser('chat-caller'),
      createTestUser('chat-mentor'),
    ]);

    const http = httpOf(instanceA);
    for (const user of [caller, mentor]) {
      await request(http).get('/me').set(authFor(user)).expect(200);
      await request(http)
        .patch('/me')
        .set(authFor(user))
        .send({ displayName: `Chat ${user.uid.slice(0, 6)}` })
        .expect(200);
    }

    const application = await request(http)
      .post('/mentors/apply')
      .set(authFor(mentor))
      .send({
        categorySlug: 'astrology',
        displayName: 'Chat Mentor',
        languages: ['English'],
        experienceYears: 4,
        ratePaisePerMinute: 1500,
      })
      .expect(201);

    mentorProfileId = application.body.id;

    const prisma = instanceA.get(PrismaService);
    await prisma.mentorProfile.update({
      where: { id: mentorProfileId },
      data: { approvalStatus: 'APPROVED', approvedAt: new Date() },
    });
    await instanceA.get(IdentityResolutionService).invalidate(mentor.uid);

    const [mentorRow, callerRow] = await Promise.all([
      prisma.user.findUnique({ where: { firebaseUid: mentor.uid } }),
      prisma.user.findUnique({ where: { firebaseUid: caller.uid } }),
    ]);
    mentorUserId = mentorRow?.id ?? '';
    callerUserId = callerRow?.id ?? '';
  }, 180_000);

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();

    const prisma = apps[0]?.get(PrismaService);
    if (prisma) {
      await prisma.session.deleteMany({ where: { mentorProfileId } }).catch(() => undefined);
      await prisma.user
        .deleteMany({ where: { firebaseUid: { in: [caller?.uid, mentor?.uid] } } })
        .catch(() => undefined);
    }

    await cleanupTestUsers();
    for (const app of apps) {
      await app.close().catch(() => undefined);
    }
  }, 60_000);

  describe('the conversation', () => {
    let sessionId: string;
    let callerSocket: Socket;
    let mentorSocket: Socket;

    beforeAll(async () => {
      sessionId = await startTextSession();
      // Deliberately opposite instances — this is the property the Redis adapter exists for.
      callerSocket = await connectChat(apps[0], caller);
      mentorSocket = await connectChat(apps[1], mentor);
    }, 120_000);

    afterAll(async () => {
      await endSession(sessionId);
    });

    it('returns empty history and a retention notice on join', async () => {
      const ack = await emit<{
        ok: boolean;
        history: { messages: unknown[]; purgedAt: string | null; messageCount: number };
        retention: { retentionDays: number; deleteAfter: string | null };
      }>(callerSocket, 'chat:join', { sessionId });

      expect(ack.ok).toBe(true);
      expect(ack.history.messages).toEqual([]);
      // Not purged — an empty live conversation and a deleted transcript must not look alike.
      expect(ack.history.purgedAt).toBeNull();
      expect(ack.retention.retentionDays).toBe(7);
      // Retention is measured from the end, and this session has not ended.
      expect(ack.retention.deleteAfter).toBeNull();

      await emit(mentorSocket, 'chat:join', { sessionId });
    }, 60_000);

    it('delivers a message from instance A to a socket on instance B', async () => {
      const received = nextEvent<{ body: string; senderUserId: string }>(
        mentorSocket,
        'chat:message',
      );

      const ack = await emit<{ ok: boolean; message: { id: string }; duplicate: boolean }>(
        callerSocket,
        'chat:send',
        { sessionId, body: 'Hello, I have a question.', clientMsgId: 'c-1' },
      );

      expect(ack).toMatchObject({ ok: true, duplicate: false });
      // The assertion the two-instance setup exists for. It fails with the in-memory adapter.
      await expect(received).resolves.toMatchObject({
        body: 'Hello, I have a question.',
        senderUserId: callerUserId,
      });
    }, 60_000);

    it('stamps the billing anchor on the FIRST message only', async () => {
      const afterFirst = await prismaOf().session.findUnique({ where: { id: sessionId } });
      expect(afterFirst?.billingAnchorAt).not.toBeNull();

      for (const i of [2, 3, 4]) {
        await emit(mentorSocket, 'chat:send', {
          sessionId,
          body: `reply ${i}`,
          clientMsgId: `m-${i}`,
        });
      }

      const afterMore = await prismaOf().session.findUnique({ where: { id: sessionId } });
      // A burst of messages must not move the meter's origin — it is stamped only-if-null.
      expect(afterMore?.billingAnchorAt?.toISOString()).toBe(
        afterFirst?.billingAnchorAt?.toISOString(),
      );
      expect(afterMore?.messageCount).toBe(4);
    }, 60_000);

    it('de-duplicates a retried clientMsgId — one row, one broadcast', async () => {
      let broadcasts = 0;
      const count = () => {
        broadcasts += 1;
      };
      mentorSocket.on('chat:message', count);

      const first = await emit<{ ok: boolean; message: { id: string }; duplicate: boolean }>(
        callerSocket,
        'chat:send',
        { sessionId, body: 'did that send?', clientMsgId: 'retry-1' },
      );
      const retry = await emit<{ ok: boolean; message: { id: string }; duplicate: boolean }>(
        callerSocket,
        'chat:send',
        { sessionId, body: 'did that send?', clientMsgId: 'retry-1' },
      );

      await settle();
      mentorSocket.off('chat:message', count);

      expect(first.duplicate).toBe(false);
      expect(retry.duplicate).toBe(true);
      // The retry returns the STORED message, so the sender reconciles its optimistic bubble
      // instead of rendering the message twice.
      expect(retry.message.id).toBe(first.message.id);
      expect(broadcasts).toBe(1);

      const rows = await prismaOf().chatMessage.count({
        where: { sessionId, clientMsgId: 'retry-1' },
      });
      expect(rows).toBe(1);
    }, 60_000);

    it('does not persist typing indicators', async () => {
      const before = await prismaOf().chatMessage.count({ where: { sessionId } });
      await emit(callerSocket, 'chat:typing', { sessionId });
      await settle(500);
      expect(await prismaOf().chatMessage.count({ where: { sessionId } })).toBe(before);
    }, 60_000);

    it('rejects a message that exceeds the length limit, as an ack rather than a hang', async () => {
      // A thrown error inside a @SubscribeMessage handler never reaches the callback, so an
      // over-long message would leave the client waiting forever.
      const ack = await emit<{ ok: boolean; error?: string }>(callerSocket, 'chat:send', {
        sessionId,
        body: 'x'.repeat(4001),
        clientMsgId: 'too-long',
      });
      expect(ack).toMatchObject({ ok: false, error: 'message_too_long' });
    }, 60_000);

    it('refuses a send from a socket that never joined', async () => {
      const fresh = await connectChat(apps[0], caller);
      const ack = await emit<{ ok: boolean; error?: string }>(fresh, 'chat:send', {
        sessionId,
        body: 'sneaking in',
        clientMsgId: 'no-join',
      });
      // Joining is what authorised the socket for this session; sending without it would skip
      // that check entirely.
      expect(ack).toMatchObject({ ok: false, error: 'not_joined' });
    }, 60_000);

    it('hides the conversation from a third party', async () => {
      const stranger = await createTestUser('chat-stranger');
      await request(httpOf(apps[0])).get('/me').set(authFor(stranger)).expect(200);

      const socket = await connectChat(apps[0], stranger);
      const ack = await emit<{ ok: boolean; error?: string }>(socket, 'chat:join', { sessionId });
      // 'not_found', not 'forbidden' — the same rule as GET /sessions/:id, so a session id
      // cannot be probed for existence.
      expect(ack).toMatchObject({ ok: false, error: 'not_found' });
    }, 120_000);

    it('serves the transcript over HTTP for history views', async () => {
      const response = await request(httpOf(apps[1]))
        .get(`/sessions/${sessionId}/messages`)
        .set(authFor(mentor))
        .expect(200);

      expect(response.body.messages.length).toBeGreaterThan(0);
      expect(response.body.purgedAt).toBeNull();
      expect(response.body.retention.retentionDays).toBe(7);
    }, 60_000);

    it('closes the pane on both sides when the session ends', async () => {
      const callerEnded = nextEvent<{ sessionId: string; endReason: string }>(
        callerSocket,
        'chat:ended',
      );
      const mentorEnded = nextEvent<{ sessionId: string }>(mentorSocket, 'chat:ended');

      await request(httpOf(apps[0]))
        .post(`/sessions/${sessionId}/end`)
        .set(authFor(caller))
        .expect(200);

      await expect(callerEnded).resolves.toMatchObject({
        sessionId,
        endReason: 'COMPLETED_BY_USER',
      });
      // Cross-instance again: the mentor is on B.
      await expect(mentorEnded).resolves.toMatchObject({ sessionId });
    }, 60_000);

    it('refuses to send into an ended conversation', async () => {
      const ack = await emit<{ ok: boolean; error?: string }>(callerSocket, 'chat:send', {
        sessionId,
        body: 'one more thing',
        clientMsgId: 'after-end',
      });
      expect(ack).toMatchObject({ ok: false, error: 'session_not_active' });
    }, 60_000);
  });

  describe('the idle backstop', () => {
    it('ends a text session whose conversation has gone quiet', async () => {
      const sessionId = await startTextSession();
      const socket = await connectChat(apps[0], caller);
      await emit(socket, 'chat:join', { sessionId });
      await emit(socket, 'chat:send', { sessionId, body: 'anyone there?', clientMsgId: 'idle-1' });

      // Back-date the activity rather than waiting out CHAT_IDLE_TIMEOUT_S. The cutoff
      // arithmetic is what is under test, not the wall clock.
      await prismaOf().session.update({
        where: { id: sessionId },
        data: { lastMessageAt: new Date(Date.now() - 60 * 60 * 1000) },
      });

      await apps[0].get(ChatIdleScheduler).sweep();

      const settled = await prismaOf().session.findUnique({ where: { id: sessionId } });
      // Without this sweep a forgotten browser tab holds an ACTIVE session forever — holding
      // both parties' in-flight slots today, and draining a wallet once M10 lands.
      expect(settled).toMatchObject({ status: 'COMPLETED', endReason: 'IDLE_TIMEOUT' });
    }, 120_000);
  });

  describe('transcript retention', () => {
    let sessionId: string;

    beforeAll(async () => {
      sessionId = await startTextSession();
      const socket = await connectChat(apps[0], caller);
      await emit(socket, 'chat:join', { sessionId });
      for (const i of [1, 2, 3]) {
        await emit(socket, 'chat:send', {
          sessionId,
          body: `retained message ${i}`,
          clientMsgId: `keep-${i}`,
        });
      }
      await endSession(sessionId);
    }, 120_000);

    it('keeps a transcript that is still inside the retention window', async () => {
      await apps[0].get(ChatRetentionScheduler).sweep();

      const session = await prismaOf().session.findUnique({ where: { id: sessionId } });
      expect(session?.messagesPurgedAt).toBeNull();
      expect(await prismaOf().chatMessage.count({ where: { sessionId } })).toBe(3);
    }, 60_000);

    it('keeps an aged transcript that has not been summarised and is inside the backstop', async () => {
      // Eight days old: past CHAT_RETENTION_DAYS but well inside CHAT_HARD_DELETE_DAYS, and
      // with no summary. Deleting it now would destroy content nothing has read.
      await ageSession(sessionId, 8);

      await apps[0].get(ChatRetentionScheduler).sweep();

      const session = await prismaOf().session.findUnique({ where: { id: sessionId } });
      expect(session?.messagesPurgedAt).toBeNull();
      expect(await prismaOf().chatMessage.count({ where: { sessionId } })).toBe(3);
    }, 60_000);

    it('purges an aged transcript once the summary is settled', async () => {
      // `summaryIneligibleReason` is the only "settled" signal that exists before M8. M8 adds
      // the `SessionSummary.status === COMPLETE` arm to the same repo method.
      await prismaOf().session.update({
        where: { id: sessionId },
        data: { summaryIneligibleReason: 'NO_CONSENT' },
      });

      await apps[0].get(ChatRetentionScheduler).sweep();

      const session = await prismaOf().session.findUnique({ where: { id: sessionId } });
      expect(session?.messagesPurgedAt).not.toBeNull();
      expect(await prismaOf().chatMessage.count({ where: { sessionId } })).toBe(0);
      // The count survives the purge: "3 messages, transcript deleted" stays renderable.
      expect(session?.messageCount).toBe(3);
    }, 60_000);

    it('reports the purge distinctly from an empty conversation', async () => {
      const response = await request(httpOf(apps[0]))
        .get(`/sessions/${sessionId}/messages`)
        .set(authFor(caller))
        .expect(200);

      expect(response.body.messages).toEqual([]);
      expect(response.body.purgedAt).not.toBeNull();
      expect(response.body.messageCount).toBe(3);
    }, 60_000);

    it('is idempotent — a second sweep neither re-deletes nor re-times the purge', async () => {
      const before = await prismaOf().session.findUnique({ where: { id: sessionId } });

      await apps[0].get(ChatRetentionScheduler).sweep();

      const after = await prismaOf().session.findUnique({ where: { id: sessionId } });
      // The moment a transcript was destroyed is not a field to overwrite casually.
      expect(after?.messagesPurgedAt?.toISOString()).toBe(before?.messagesPurgedAt?.toISOString());
    }, 60_000);

    it('purges an un-summarised transcript once it passes the hard backstop', async () => {
      const other = await startTextSession();
      const socket = await connectChat(apps[0], caller);
      await emit(socket, 'chat:join', { sessionId: other });
      await emit(socket, 'chat:send', { sessionId: other, body: 'old talk', clientMsgId: 'old-1' });
      await endSession(other);

      // Forty days: past CHAT_HARD_DELETE_DAYS with no summary. Delete-on-summarise alone
      // would leak this transcript forever.
      await ageSession(other, 40);

      await apps[0].get(ChatRetentionScheduler).sweep();

      const session = await prismaOf().session.findUnique({ where: { id: other } });
      expect(session?.messagesPurgedAt).not.toBeNull();
      expect(await prismaOf().chatMessage.count({ where: { sessionId: other } })).toBe(0);
    }, 120_000);
  });
});

const settle = (ms = 1200): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
