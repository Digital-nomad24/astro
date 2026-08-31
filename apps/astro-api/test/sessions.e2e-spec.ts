import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import * as request from 'supertest';

import { AppModule } from '../src/app/app.module';
import { IdentityResolutionService } from '../src/app/identity/application/services/identity-resolution.service';
import { PresenceService } from '../src/app/presence/application/services/presence.service';
import { REDIS_CLIENT } from '../src/app/infra/redis/redis.tokens';
import { RedisIoAdapter } from '../src/config/redis-io.adapter';
import { PrismaService } from '../prisma/prisma.service';
import { cleanupTestUsers, createTestUser, type TestUser } from './firebase-test-user';
import { liveKitWebhookBody, signLiveKitWebhook } from './livekit-webhook-signer';

/**
 * The voice session lifecycle, end to end against real Postgres, real Redis and a real
 * LiveKit Cloud project.
 *
 * The webhook half is the part worth the setup cost. Two of the three ways this integration
 * fails silently in production are unreachable by a unit test:
 *
 *   - LiveKit posts `Content-Type: application/webhook+json`, which Express's default JSON
 *     parser ignores — the handler gets an empty body and every event 401s.
 *   - The signature is over the exact bytes sent, so any re-serialisation of the parsed object
 *     breaks it.
 *
 * Both only show up once a real HTTP request with a real content type goes through the real
 * middleware stack, which is why these assert on the transport and not on the processor.
 */
describe('sessions and the LiveKit webhook', () => {
  let app: NestExpressApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const sockets: Socket[] = [];

  let caller: TestUser;
  let mentor: TestUser;
  let mentorProfileId: string;
  let mentorUserId: string;
  let callerUserId: string;

  const authFor = (user: TestUser) => ({ Authorization: `Bearer ${user.idToken}` });

  const connectCalls = async (user: TestUser): Promise<Socket> => {
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

  /**
   * Posts a webhook the way LiveKit does — correct content type, signature over these exact
   * bytes. The expected status is a parameter rather than a chained `.expect()` because the
   * signature has to be awaited first, and awaiting a supertest chain resolves it to a
   * `Response`, which has no `.expect`.
   */
  const postWebhook = async (body: string, expectStatus: number, authHeader?: string) =>
    request(http)
      .post('/webhooks/livekit')
      .set('Content-Type', 'application/webhook+json')
      .set('Authorization', authHeader ?? (await signLiveKitWebhook(body)))
      .send(body)
      .expect(expectStatus);

  /** Puts the mentor back to a bookable state between tests. */
  const bringMentorOnline = async (): Promise<void> => {
    await app.get(PresenceService).goOnline(mentorUserId, true);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    // Two things here mirror `main.ts` exactly, and both are load-bearing for the webhook
    // tests. `rawBody: true` preserves the unparsed bytes the signature is computed over —
    // without it `req.rawBody` is undefined and every webhook 401s. The Express typing is what
    // makes `useBodyParser` available below.
    app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    // Matches main.ts. Without this the webhook body never reaches the handler, which is one
    // of the two failures under test.
    app.useBodyParser('json', {
      type: ['application/json', 'application/webhook+json'],
      limit: '1mb',
    });

    const adapter = new RedisIoAdapter(app, app.get<Redis>(REDIS_CLIENT));
    await adapter.connect();
    app.useWebSocketAdapter(adapter);

    await app.init();
    await app.listen(0);
    http = app.getHttpServer();

    [caller, mentor] = await Promise.all([
      createTestUser('session-caller'),
      createTestUser('session-mentor'),
    ]);

    for (const user of [caller, mentor]) {
      await request(http).get('/me').set(authFor(user)).expect(200);
      await request(http)
        .patch('/me')
        .set(authFor(user))
        .send({ displayName: `E2E ${user.uid.slice(0, 6)}` })
        .expect(200);
    }

    const application = await request(http)
      .post('/mentors/apply')
      .set(authFor(mentor))
      .send({
        categorySlug: 'astrology',
        displayName: 'Session Mentor',
        languages: ['English'],
        experienceYears: 5,
        ratePaisePerMinute: 2000,
      })
      .expect(201);

    mentorProfileId = application.body.id;

    const prisma = app.get(PrismaService);
    await prisma.mentorProfile.update({
      where: { id: mentorProfileId },
      data: { approvalStatus: 'APPROVED', approvedAt: new Date() },
    });
    await app.get(IdentityResolutionService).invalidate(mentor.uid);

    const [mentorRow, callerRow] = await Promise.all([
      prisma.user.findUnique({ where: { firebaseUid: mentor.uid } }),
      prisma.user.findUnique({ where: { firebaseUid: caller.uid } }),
    ]);
    mentorUserId = mentorRow?.id ?? '';
    callerUserId = callerRow?.id ?? '';
  }, 180_000);

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();

    const prisma = app?.get(PrismaService);
    if (prisma) {
      await prisma.session.deleteMany({ where: { mentorProfileId } }).catch(() => undefined);
      await prisma.webhookEvent
        .deleteMany({ where: { eventId: { startsWith: 'e2e_' } } })
        .catch(() => undefined);
      await prisma.user
        .deleteMany({ where: { firebaseUid: { in: [caller?.uid, mentor?.uid] } } })
        .catch(() => undefined);
    }

    await cleanupTestUsers();
    await app?.close().catch(() => undefined);
  }, 60_000);

  describe('creation guards', () => {
    it('rejects VIDEO at the DTO, before any session row exists', async () => {
      const response = await request(http)
        .post('/sessions')
        .set(authFor(caller))
        .send({ mentorProfileId, mode: 'VIDEO' })
        .expect(400);

      // The enum carries VIDEO so enabling it later is a grant change rather than a migration
      // under load — but nothing may create one today.
      expect(response.body.code).toBeDefined();
    });

    it('refuses to start a session with an offline mentor', async () => {
      await app.get(PresenceService).goOffline(mentorUserId);

      const response = await request(http)
        .post('/sessions')
        .set(authFor(caller))
        .send({ mentorProfileId, mode: 'VOICE' })
        .expect(409);

      expect(response.body.code).toBe('MENTOR_OFFLINE');
    });
  });

  describe('the full voice lifecycle', () => {
    let sessionId: string;
    let roomName: string;
    let mentorSocket: Socket;
    let callerSocket: Socket;

    it('rings the mentor and hands the caller LiveKit credentials', async () => {
      await bringMentorOnline();
      mentorSocket = await connectCalls(mentor);
      callerSocket = await connectCalls(caller);

      const incoming = nextEvent<{ session: { id: string }; ringExpiresAtMs: number }>(
        mentorSocket,
        'calls:incoming',
      );

      const response = await request(http)
        .post('/sessions')
        .set(authFor(caller))
        .send({ mentorProfileId, mode: 'VOICE' })
        .expect(201);

      sessionId = response.body.session.id;
      roomName = response.body.credentials.roomName;

      expect(response.body.session).toMatchObject({
        status: 'RINGING',
        mode: 'VOICE',
        // Frozen at creation, never a read of MentorProfile.
        ratePaisePerMinute: 2000,
        billingAnchorAt: null,
        billedSeconds: null,
      });
      expect(response.body.credentials).toMatchObject({
        sessionId,
        roomName: `session:${sessionId}`,
      });
      expect(typeof response.body.credentials.token).toBe('string');

      // The push half: the mentor's dashboard learns about a call it never asked for.
      await expect(incoming).resolves.toMatchObject({ session: { id: sessionId } });
    }, 90_000);

    it('refuses a second concurrent session for the same caller', async () => {
      // The partial unique index is the guarantee; the pre-flight check is only the friendly
      // path to the same 409.
      const response = await request(http)
        .post('/sessions')
        .set(authFor(caller))
        .send({ mentorProfileId, mode: 'VOICE' })
        .expect(409);

      expect(['SESSION_ALREADY_IN_FLIGHT', 'MENTOR_BUSY']).toContain(response.body.code);
    });

    it('hides the session from a third party as a 404, not a 403', async () => {
      const stranger = await createTestUser('session-stranger');
      await request(http).get('/me').set(authFor(stranger)).expect(200);

      // 403 would confirm the id is real, letting anyone enumerate live sessions.
      await request(http).get(`/sessions/${sessionId}`).set(authFor(stranger)).expect(404);
    }, 90_000);

    it('lets only the mentor accept, and marks them BUSY', async () => {
      await request(http).post(`/sessions/${sessionId}/accept`).set(authFor(caller)).expect(403);

      const response = await request(http)
        .post(`/sessions/${sessionId}/accept`)
        .set(authFor(mentor))
        .expect(200);

      expect(response.body.session).toMatchObject({ status: 'ACTIVE' });
      expect(response.body.credentials.identity).toBe(`mentor:${mentorUserId}`);

      const [presence] = await app.get(PresenceService).snapshotFor([mentorProfileId]);
      expect(presence?.state).toBe('BUSY');
    });

    it('does NOT stamp the billing anchor when only one party has joined', async () => {
      const body = liveKitWebhookBody({
        event: 'participant_joined',
        eventId: `e2e_join_user_${sessionId}`,
        roomName,
        participantIdentity: `user:${callerUserId}`,
      });

      await postWebhook(body, 200);
      await settle();

      const session = await app.get(PrismaService).session.findUnique({ where: { id: sessionId } });
      // A mentor must not bill for the user sitting alone in a room waiting for them to pick up.
      expect(session?.billingAnchorAt).toBeNull();
      expect(session?.participantJoinCount).toBe(1);
    });

    it('stamps the anchor when the second party joins, and announces it', async () => {
      const connected = nextEvent<{ sessionId: string; billingAnchorAt: string }>(
        callerSocket,
        'calls:connected',
      );

      const body = liveKitWebhookBody({
        event: 'participant_joined',
        eventId: `e2e_join_mentor_${sessionId}`,
        roomName,
        participantIdentity: `mentor:${mentorUserId}`,
      });
      await postWebhook(body, 200);

      await expect(connected).resolves.toMatchObject({ sessionId });

      const session = await app.get(PrismaService).session.findUnique({ where: { id: sessionId } });
      expect(session?.billingAnchorAt).not.toBeNull();
      expect(session?.connectedIdentities.sort()).toEqual([
        `mentor:${mentorUserId}`,
        `user:${callerUserId}`,
      ]);
    });

    it('treats a redelivered webhook as a no-op and never moves the anchor', async () => {
      const before = await app.get(PrismaService).session.findUnique({ where: { id: sessionId } });

      const body = liveKitWebhookBody({
        event: 'participant_joined',
        eventId: `e2e_join_mentor_${sessionId}`, // same event id as the previous test
        roomName,
        participantIdentity: `mentor:${mentorUserId}`,
      });
      await postWebhook(body, 200);
      await settle();

      const after = await app.get(PrismaService).session.findUnique({ where: { id: sessionId } });
      // The inbox's unique key makes redelivery a no-op INSERT, so nothing downstream runs.
      expect(after?.billingAnchorAt?.toISOString()).toBe(before?.billingAnchorAt?.toISOString());
      expect(after?.participantJoinCount).toBe(before?.participantJoinCount);

      const rows = await app.get(PrismaService).webhookEvent.count({
        where: { eventId: `e2e_join_mentor_${sessionId}` },
      });
      expect(rows).toBe(1);
    });

    it('records consent per party, and does not re-time it on a repeat', async () => {
      const first = await request(http)
        .post(`/sessions/${sessionId}/consent`)
        .set(authFor(caller))
        .expect(200);
      expect(first.body).toMatchObject({
        recordingConsentUser: true,
        recordingConsentMentor: false,
      });

      const stamped = await app.get(PrismaService).session.findUnique({ where: { id: sessionId } });

      await request(http).post(`/sessions/${sessionId}/consent`).set(authFor(caller)).expect(200);

      const again = await app.get(PrismaService).session.findUnique({ where: { id: sessionId } });
      // Consent is stamped once. The moment it was given is the one field here most likely to
      // be asked about later.
      expect(again?.recordingConsentUserAt?.toISOString()).toBe(
        stamped?.recordingConsentUserAt?.toISOString(),
      );
    });

    it('re-issues join credentials for a reconnecting participant', async () => {
      const response = await request(http)
        .post(`/sessions/${sessionId}/credentials`)
        .set(authFor(caller))
        .expect(200);

      expect(response.body.credentials).toMatchObject({
        sessionId,
        identity: `user:${callerUserId}`,
      });
      expect(response.body.session.status).toBe('ACTIVE');
    });

    it('returns the in-flight session and fresh credentials on calls:resync', async () => {
      const ack = await new Promise<{
        ok: boolean;
        session: { id: string } | null;
        credentials: { token: string } | null;
      }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('resync ack timed out')), 20_000);
        callerSocket.emit('calls:resync', {}, (result: never) => {
          clearTimeout(timer);
          resolve(result);
        });
      });

      expect(ack.ok).toBe(true);
      expect(ack.session?.id).toBe(sessionId);
      expect(typeof ack.credentials?.token).toBe('string');
    });

    it('ends the call, records a reason, and releases the mentor', async () => {
      const ended = nextEvent<{ sessionId: string; endReason: string }>(
        mentorSocket,
        'calls:ended',
      );

      const response = await request(http)
        .post(`/sessions/${sessionId}/end`)
        .set(authFor(caller))
        .expect(200);

      expect(response.body).toMatchObject({
        status: 'COMPLETED',
        endReason: 'COMPLETED_BY_USER',
      });
      expect(response.body.billedSeconds).toBeGreaterThanOrEqual(0);
      await expect(ended).resolves.toMatchObject({ sessionId, endReason: 'COMPLETED_BY_USER' });

      const [presence] = await app.get(PresenceService).snapshotFor([mentorProfileId]);
      expect(presence?.state).toBe('ONLINE');
    });

    it('refuses to end an already-ended session', async () => {
      const response = await request(http)
        .post(`/sessions/${sessionId}/end`)
        .set(authFor(caller))
        .expect(409);
      expect(response.body.code).toBe('SESSION_ALREADY_ENDED');
    });

    it('lists the completed session in the caller history', async () => {
      const response = await request(http).get('/sessions').set(authFor(caller)).expect(200);

      expect(response.body.items[0]).toMatchObject({ id: sessionId, status: 'COMPLETED' });
    });
  });

  describe('webhook authentication', () => {
    it('rejects a tampered body whose signature is otherwise valid', async () => {
      const original = liveKitWebhookBody({
        event: 'room_finished',
        eventId: 'e2e_tamper_1',
        roomName: 'session:does-not-exist',
      });
      const authHeader = await signLiveKitWebhook(original);

      const tampered = liveKitWebhookBody({
        event: 'room_finished',
        eventId: 'e2e_tamper_2',
        roomName: 'session:does-not-exist',
      });

      // Same valid, unexpired, correctly-issued JWT over different bytes. The sha256 claim is
      // what stops this, and it is the reason the raw body must survive the middleware stack.
      await postWebhook(tampered, 401, authHeader);
    });

    it('rejects a webhook with no Authorization header', async () => {
      const body = liveKitWebhookBody({
        event: 'room_finished',
        eventId: 'e2e_noauth',
        roomName: 'session:does-not-exist',
      });

      await request(http)
        .post('/webhooks/livekit')
        .set('Content-Type', 'application/webhook+json')
        .send(body)
        .expect(401);
    });

    it('accepts a correctly signed event for a room we never created', async () => {
      // Accepted (the signature is genuine) but applied to nothing. Recorded so the inbox has
      // the evidence, and marked processed so it does not sit in the retry queue forever.
      const body = liveKitWebhookBody({
        event: 'room_finished',
        eventId: 'e2e_unknown_room',
        roomName: 'not-one-of-ours',
      });

      await postWebhook(body, 200);
      await settle();

      const row = await app
        .get(PrismaService)
        .webhookEvent.findFirst({ where: { eventId: 'e2e_unknown_room' } });
      expect(row?.sessionId).toBeNull();
      expect(row?.processedAt).not.toBeNull();
    });
  });
});

/**
 * Webhook processing is deliberately not awaited by the controller — the 200 goes out first,
 * so LiveKit stops retrying an event we have already accepted durably. Tests that assert on
 * the *effect* therefore have to wait for it.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1500));
