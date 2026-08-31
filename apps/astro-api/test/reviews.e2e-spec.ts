import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';

import { AppModule } from '../src/app/app.module';
import { IdentityResolutionService } from '../src/app/identity/application/services/identity-resolution.service';
import { PresenceService } from '../src/app/presence/application/services/presence.service';
import { RatingReconcilerScheduler } from '../src/app/reviews/application/schedulers/rating-reconciler.scheduler';
import { PrismaService } from '../prisma/prisma.service';
import { cleanupTestUsers, createTestUser, type TestUser } from './firebase-test-user';

/**
 * Ratings, against real Postgres.
 *
 * The property under test is one line: **`MentorProfile.ratingSum/Count/Avg` always agrees
 * with the `Review` rows it summarises.** That aggregate is a browse sort key, so a window in
 * which it disagrees is a window in which mentors are ranked wrongly on the hottest read path
 * in the product — and it is maintained by a transaction, which a mocked Prisma cannot
 * exercise at all.
 */
describe('reviews and the rating aggregate', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;

  let mentor: TestUser;
  let admin: TestUser;
  let mentorProfileId: string;
  let mentorUserId: string;
  const callers: TestUser[] = [];

  const authFor = (user: TestUser) => ({ Authorization: `Bearer ${user.idToken}` });
  const prismaOf = () => app.get(PrismaService);

  const aggregate = async () => {
    const row = await prismaOf().mentorProfile.findUniqueOrThrow({
      where: { id: mentorProfileId },
      select: { ratingSum: true, ratingCount: true, ratingAvg: true },
    });
    return row;
  };

  /** Re-derives the truth from the reviews and asserts the cache matches it. */
  const expectAggregateConsistent = async (): Promise<void> => {
    const visible = await prismaOf().review.findMany({
      where: { mentorProfileId, isHidden: false },
      select: { rating: true },
    });
    const sum = visible.reduce((total, row) => total + row.rating, 0);
    const cached = await aggregate();

    expect(cached.ratingSum).toBe(sum);
    expect(cached.ratingCount).toBe(visible.length);
    expect(cached.ratingAvg).toBeCloseTo(visible.length > 0 ? sum / visible.length : 0, 6);
  };

  /** Runs a complete consultation and returns its id, ready to be reviewed. */
  const completeSession = async (caller: TestUser): Promise<string> => {
    await app.get(PresenceService).goOnline(mentorUserId, true);

    const created = await request(http)
      .post('/sessions')
      .set(authFor(caller))
      .send({ mentorProfileId, mode: 'TEXT' })
      .expect(201);
    const sessionId: string = created.body.session.id;

    await request(http).post(`/sessions/${sessionId}/accept`).set(authFor(mentor)).expect(200);

    // A review needs a consultation that actually happened, and `billingAnchorAt` is the only
    // signal that both parties were present. Stamped directly rather than by exchanging
    // messages — the chat path is covered by its own suite.
    await prismaOf().session.update({
      where: { id: sessionId },
      data: { billingAnchorAt: new Date() },
    });
    await request(http).post(`/sessions/${sessionId}/end`).set(authFor(caller)).expect(200);

    return sessionId;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    await app.listen(0);
    http = app.getHttpServer();

    mentor = await createTestUser('review-mentor');
    admin = await createTestUser('review-admin');
    for (const label of ['review-a', 'review-b', 'review-c']) {
      callers.push(await createTestUser(label));
    }

    for (const user of [mentor, admin, ...callers]) {
      await request(http).get('/me').set(authFor(user)).expect(200);
      await request(http)
        .patch('/me')
        .set(authFor(user))
        .send({ displayName: `R ${user.uid.slice(0, 6)}` })
        .expect(200);
    }

    const application = await request(http)
      .post('/mentors/apply')
      .set(authFor(mentor))
      .send({
        categorySlug: 'astrology',
        displayName: 'Review Mentor',
        languages: ['English'],
        experienceYears: 7,
        ratePaisePerMinute: 1200,
      })
      .expect(201);

    mentorProfileId = application.body.id;

    const prisma = app.get(PrismaService);
    await prisma.mentorProfile.update({
      where: { id: mentorProfileId },
      data: { approvalStatus: 'APPROVED', approvedAt: new Date() },
    });
    await prisma.user.update({ where: { firebaseUid: admin.uid }, data: { role: 'ADMIN' } });
    await app.get(IdentityResolutionService).invalidate(mentor.uid);
    await app.get(IdentityResolutionService).invalidate(admin.uid);

    const mentorRow = await prisma.user.findUnique({ where: { firebaseUid: mentor.uid } });
    mentorUserId = mentorRow?.id ?? '';
  }, 240_000);

  afterAll(async () => {
    const prisma = app?.get(PrismaService);
    if (prisma) {
      await prisma.review.deleteMany({ where: { mentorProfileId } }).catch(() => undefined);
      await prisma.session.deleteMany({ where: { mentorProfileId } }).catch(() => undefined);
      await prisma.user
        .deleteMany({
          where: {
            firebaseUid: { in: [mentor?.uid, admin?.uid, ...callers.map((c) => c.uid)] },
          },
        })
        .catch(() => undefined);
    }
    await cleanupTestUsers();
    await app?.close().catch(() => undefined);
  }, 60_000);

  describe('submitting', () => {
    let sessionId: string;

    it('refuses to review a consultation that never took place', async () => {
      await app.get(PresenceService).goOnline(mentorUserId, true);
      const created = await request(http)
        .post('/sessions')
        .set(authFor(callers[0]))
        .send({ mentorProfileId, mode: 'TEXT' })
        .expect(201);

      const response = await request(http)
        .post(`/sessions/${created.body.session.id}/review`)
        .set(authFor(callers[0]))
        .send({ rating: 5 })
        .expect(409);
      // Still RINGING. Rating a call nobody answered would be rating nothing.
      expect(response.body.code).toBe('SESSION_NOT_REVIEWABLE');

      await request(http)
        .post(`/sessions/${created.body.session.id}/cancel`)
        .set(authFor(callers[0]))
        .expect(200);
    }, 120_000);

    it('moves the mentor rating in the same breath as the review', async () => {
      sessionId = await completeSession(callers[0]);
      const before = await aggregate();

      const review = await request(http)
        .post(`/sessions/${sessionId}/review`)
        .set(authFor(callers[0]))
        .send({ rating: 4, comment: '  Very helpful.  ' })
        .expect(200);

      expect(review.body).toMatchObject({ rating: 4, comment: 'Very helpful.', isMine: true });

      const after = await aggregate();
      expect(after.ratingCount).toBe(before.ratingCount + 1);
      expect(after.ratingSum).toBe(before.ratingSum + 4);
      await expectAggregateConsistent();
    }, 180_000);

    it('adjusts the sum but not the count when a review is edited', async () => {
      const before = await aggregate();

      await request(http)
        .post(`/sessions/${sessionId}/review`)
        .set(authFor(callers[0]))
        .send({ rating: 2 })
        .expect(200);

      const after = await aggregate();
      // 4 → 2 is a delta of -2 with no change to the count. A misclicked star is the most
      // common thing anyone wants to fix about a review.
      expect(after.ratingSum).toBe(before.ratingSum - 2);
      expect(after.ratingCount).toBe(before.ratingCount);
      await expectAggregateConsistent();

      const rows = await prismaOf().review.count({ where: { sessionId } });
      expect(rows).toBe(1);
    }, 120_000);

    it('rejects a rating outside 1..5 before it reaches the aggregate', async () => {
      for (const rating of [0, 6, -1]) {
        await request(http)
          .post(`/sessions/${sessionId}/review`)
          .set(authFor(callers[0]))
          .send({ rating })
          .expect(400);
      }
      await expectAggregateConsistent();
    }, 120_000);

    it('refuses a review from the mentor, and from a stranger', async () => {
      // The mentor is a participant, so they pass the session check — the caller check is what
      // stops a mentor rating their own consultation.
      const asMentor = await request(http)
        .post(`/sessions/${sessionId}/review`)
        .set(authFor(mentor))
        .send({ rating: 5 })
        .expect(409);
      expect(asMentor.body.code).toBe('NOT_THE_CALLER');

      // 404, not 403 — the same rule as GET /sessions/:id, so an id cannot be probed.
      await request(http)
        .post(`/sessions/${sessionId}/review`)
        .set(authFor(callers[1]))
        .send({ rating: 1 })
        .expect(404);
    }, 120_000);

    it('closes the window on an old consultation', async () => {
      const old = await completeSession(callers[1]);
      const session = await prismaOf().session.findUniqueOrThrow({ where: { id: old } });
      const shift = 60 * 24 * 60 * 60 * 1000;

      // The whole timeline moves together — `Session_timestamps_ordered` refuses a row that
      // ended before it was created.
      await prismaOf().session.update({
        where: { id: old },
        data: {
          createdAt: new Date(session.createdAt.getTime() - shift),
          ringingAt: session.ringingAt && new Date(session.ringingAt.getTime() - shift),
          acceptedAt: session.acceptedAt && new Date(session.acceptedAt.getTime() - shift),
          billingAnchorAt:
            session.billingAnchorAt && new Date(session.billingAnchorAt.getTime() - shift),
          endedAt: session.endedAt && new Date(session.endedAt.getTime() - shift),
        },
      });

      const response = await request(http)
        .post(`/sessions/${old}/review`)
        .set(authFor(callers[1]))
        .send({ rating: 1 })
        .expect(409);
      expect(response.body.code).toBe('REVIEW_WINDOW_CLOSED');
    }, 180_000);
  });

  describe('reading', () => {
    it('shows the rating on the session itself, for both parties', async () => {
      const asCaller = await request(http).get('/sessions').set(authFor(callers[0])).expect(200);
      const reviewed = asCaller.body.items.find(
        (s: { rating: number | null }) => s.rating !== null,
      );
      // Carried on the session so a history list can offer "rate this" without a request per row.
      expect(reviewed?.rating).toBe(2);

      const asMentor = await request(http)
        .get('/sessions?as=mentor')
        .set(authFor(mentor))
        .expect(200);
      expect(asMentor.body.items.some((s: { rating: number | null }) => s.rating === 2)).toBe(true);
    }, 120_000);

    it('lists a mentor reviews and their star distribution', async () => {
      const reviews = await request(http)
        .get(`/mentors/${mentorProfileId}/reviews`)
        .set(authFor(callers[2]))
        .expect(200);
      expect(reviews.body.items.length).toBeGreaterThan(0);
      // Not the caller's own review, so no edit affordance.
      expect(reviews.body.items[0].isMine).toBe(false);

      const rating = await request(http)
        .get(`/mentors/${mentorProfileId}/rating`)
        .set(authFor(callers[2]))
        .expect(200);
      const cached = await aggregate();
      // The profile page and the browse card must agree — they are the same number.
      expect(rating.body.ratingAvg).toBeCloseTo(cached.ratingAvg, 6);
      expect(rating.body.distribution[2]).toBe(1);
    }, 120_000);
  });

  describe('moderation', () => {
    let reviewId: string;

    it('removes a hidden review from the aggregate', async () => {
      const review = await prismaOf().review.findFirstOrThrow({ where: { mentorProfileId } });
      reviewId = review.id;
      const before = await aggregate();

      const response = await request(http)
        .post(`/admin/reviews/${reviewId}/moderate`)
        .set(authFor(admin))
        .send({ hidden: true, reason: 'Abusive language' })
        .expect(200);
      expect(response.body.changed).toBe(true);

      const after = await aggregate();
      // Otherwise the browse card keeps counting an opinion nobody can read.
      expect(after.ratingCount).toBe(before.ratingCount - 1);
      expect(after.ratingSum).toBe(before.ratingSum - review.rating);
      await expectAggregateConsistent();
    }, 120_000);

    it('is a no-op when hidden twice, rather than subtracting twice', async () => {
      const before = await aggregate();

      const response = await request(http)
        .post(`/admin/reviews/${reviewId}/moderate`)
        .set(authFor(admin))
        .send({ hidden: true, reason: 'Abusive language' })
        .expect(200);

      // A second click on "hide" is a no-op, not a failure and not a double subtraction.
      expect(response.body.changed).toBe(false);
      expect(await aggregate()).toEqual(before);
    }, 120_000);

    it('hides the review from its own author too', async () => {
      const response = await request(http)
        .get(
          `/sessions/${(await prismaOf().review.findUniqueOrThrow({ where: { id: reviewId } })).sessionId}/review`,
        )
        .set(authFor(callers[0]))
        .expect(200);
      // A moderated review the author can still see reads as a shadow-ban.
      expect(response.body).toEqual({});
    }, 120_000);

    it('restores the contribution when unhidden', async () => {
      const before = await aggregate();

      await request(http)
        .post(`/admin/reviews/${reviewId}/moderate`)
        .set(authFor(admin))
        .send({ hidden: false })
        .expect(200);

      const after = await aggregate();
      expect(after.ratingCount).toBe(before.ratingCount + 1);
      await expectAggregateConsistent();
    }, 120_000);

    it('refuses moderation from a non-admin', async () => {
      await request(http)
        .post(`/admin/reviews/${reviewId}/moderate`)
        .set(authFor(callers[0]))
        .send({ hidden: true, reason: 'nope' })
        .expect(403);
    }, 120_000);
  });

  describe('the drift reconciler', () => {
    it('reports zero corrections on a healthy aggregate', async () => {
      // The whole point of the transactional write. This job is a detector first and a repair
      // second — a non-zero count here means something wrote outside the transaction.
      const result = await app.get(RatingReconcilerScheduler).run();
      expect(result.corrected).toBe(0);
      await expectAggregateConsistent();
    }, 120_000);

    it('repairs an aggregate corrupted behind the transaction back', async () => {
      // Exactly what a bad migration or a manual UPDATE would leave behind.
      await prismaOf().mentorProfile.update({
        where: { id: mentorProfileId },
        data: { ratingSum: 999, ratingCount: 42, ratingAvg: 4.9 },
      });

      const result = await app.get(RatingReconcilerScheduler).run();

      expect(result.corrected).toBeGreaterThanOrEqual(1);
      await expectAggregateConsistent();
    }, 120_000);
  });
});
