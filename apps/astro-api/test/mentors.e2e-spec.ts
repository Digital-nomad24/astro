import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';

import { AppModule } from '../src/app/app.module';
import { IdentityResolutionService } from '../src/app/identity/application/services/identity-resolution.service';
import { PrismaService } from '../prisma/prisma.service';
import { cleanupTestUsers, createTestUser, type TestUser } from './firebase-test-user';

/**
 * The M2 acceptance path, end to end against real Firebase and real Postgres:
 * apply → invisible in catalogue → admin approves → visible and bookable.
 */
describe('mentor catalogue', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let identity: IdentityResolutionService;

  let consumer: TestUser;
  let applicant: TestUser;
  let adminUser: TestUser;

  const auth = (user: TestUser) => ({ Authorization: `Bearer ${user.idToken}` });

  /** Minimal approved mentors for browse tests — not part of the dev seed. */
  async function seedBrowseFixtures(): Promise<void> {
    const categories = await prisma.mentorCategory.findMany();
    const bySlug = (slug: string) => categories.find((c) => c.slug === slug);
    const tarot = bySlug('tarot');
    const astrology = bySlug('astrology');
    if (!tarot || !astrology) {
      throw new Error(
        'Run db:seed first — mentor categories are required for e2e browse fixtures.',
      );
    }

    const specs = [
      { suffix: '01', categoryId: tarot.id, ratingAvg: 4.9, ratingCount: 100, rate: 1500 },
      { suffix: '02', categoryId: tarot.id, ratingAvg: 4.5, ratingCount: 80, rate: 1800 },
      { suffix: '03', categoryId: astrology.id, ratingAvg: 4.2, ratingCount: 60, rate: 1200 },
      { suffix: '04', categoryId: astrology.id, ratingAvg: 3.8, ratingCount: 40, rate: 2500 },
      { suffix: '05', categoryId: tarot.id, ratingAvg: 3.5, ratingCount: 20, rate: 900 },
      { suffix: '06', categoryId: astrology.id, ratingAvg: 3.2, ratingCount: 10, rate: 2000 },
      { suffix: '07', categoryId: tarot.id, ratingAvg: 3.0, ratingCount: 5, rate: 1100 },
      { suffix: '08', categoryId: astrology.id, ratingAvg: 2.8, ratingCount: 3, rate: 1600 },
      { suffix: '09', categoryId: tarot.id, ratingAvg: 2.5, ratingCount: 2, rate: 1400 },
      { suffix: '10', categoryId: astrology.id, ratingAvg: 2.2, ratingCount: 1, rate: 1300 },
      { suffix: '11', categoryId: tarot.id, ratingAvg: 2.0, ratingCount: 1, rate: 1000 },
      { suffix: '12', categoryId: astrology.id, ratingAvg: 1.5, ratingCount: 1, rate: 800 },
    ] as const;

    for (const spec of specs) {
      const firebaseUid = `e2e-browse-mentor-${spec.suffix}`;
      const user = await prisma.user.upsert({
        where: { firebaseUid },
        update: { role: 'MENTOR' },
        create: {
          firebaseUid,
          role: 'MENTOR',
          authProvider: 'OTHER',
          email: `${firebaseUid}@e2e.invalid`,
          displayName: `E2E Browse ${spec.suffix}`,
          onboardedAt: new Date(),
        },
      });
      const ratingSum = Math.round(spec.ratingAvg * spec.ratingCount);
      await prisma.mentorProfile.upsert({
        where: { userId: user.id },
        update: {
          categoryId: spec.categoryId,
          ratePaisePerMinute: spec.rate,
          approvalStatus: 'APPROVED',
          ratingSum,
          ratingCount: spec.ratingCount,
          ratingAvg: spec.ratingAvg,
        },
        create: {
          userId: user.id,
          categoryId: spec.categoryId,
          displayName: `E2E Browse ${spec.suffix}`,
          headline: 'E2E browse fixture',
          bio: 'Created for mentor catalogue e2e tests.',
          languages: ['English'],
          experienceYears: 5,
          ratePaisePerMinute: spec.rate,
          approvalStatus: 'APPROVED',
          approvedAt: new Date(),
          presenceState: 'OFFLINE',
          presenceUpdatedAt: new Date(),
          ratingSum,
          ratingCount: spec.ratingCount,
          ratingAvg: spec.ratingAvg,
        },
      });
    }
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // The exception filter is already global via APP_FILTER in AppModule.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    identity = app.get(IdentityResolutionService);

    [consumer, applicant, adminUser] = await Promise.all([
      createTestUser('consumer'),
      createTestUser('applicant'),
      createTestUser('admin'),
    ]);

    // Provision all three shadow rows by touching a guarded route.
    for (const user of [consumer, applicant, adminUser]) {
      await request(app.getHttpServer()).get('/me').set(auth(user)).expect(200);
    }

    // A custom token carries no `name` claim, so these users provision with no display name
    // and therefore un-onboarded. `POST /mentors/apply` is `@RequireOnboarded()`, so the
    // applicant has to complete their profile first — exactly as a real user would.
    await request(app.getHttpServer())
      .patch('/me')
      .set(auth(applicant))
      .send({ displayName: 'E2E Applicant' })
      .expect(200);

    // Promote one to ADMIN out of band, then invalidate — the guard authorizes on the CACHED
    // role, so a direct DB update alone would not take effect until the TTL expired.
    await prisma.user.update({ where: { firebaseUid: adminUser.uid }, data: { role: 'ADMIN' } });
    await identity.invalidate(adminUser.uid);

    await seedBrowseFixtures();
  }, 120_000);

  afterAll(async () => {
    await prisma?.mentorProfile
      .deleteMany({ where: { user: { firebaseUid: { startsWith: 'e2e-browse-mentor-' } } } })
      .catch(() => undefined);
    await prisma?.user
      .deleteMany({ where: { firebaseUid: { startsWith: 'e2e-browse-mentor-' } } })
      .catch(() => undefined);
    await prisma?.user
      .deleteMany({
        where: { firebaseUid: { in: [consumer?.uid, applicant?.uid, adminUser?.uid] } },
      })
      .catch(() => undefined);
    await cleanupTestUsers();
    await app?.close();
  });

  describe('access control', () => {
    it('requires authentication to browse', async () => {
      await request(app.getHttpServer()).get('/mentors').expect(401);
    });

    it('refuses the admin moderation queue to a normal user', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/mentors')
        .set(auth(consumer))
        .expect(403);
      expect(res.body).toMatchObject({ code: 'INSUFFICIENT_ROLE' });
    });

    it('allows an admin into the moderation queue', async () => {
      await request(app.getHttpServer()).get('/admin/mentors').set(auth(adminUser)).expect(200);
    });

    it('404s the mentor-only profile route for a consumer', async () => {
      // A consumer has role USER, so @Roles('MENTOR','ADMIN') rejects before the handler.
      await request(app.getHttpServer()).get('/mentors/me').set(auth(consumer)).expect(403);
    });
  });

  describe('browse', () => {
    it('returns mentors sorted by rating, descending', async () => {
      const res = await request(app.getHttpServer())
        .get('/mentors?limit=10')
        .set(auth(consumer))
        .expect(200);

      expect(res.body.items.length).toBe(10);
      const ratings = res.body.items.map((m: { ratingAvg: number }) => m.ratingAvg);
      expect([...ratings]).toEqual([...ratings].sort((a: number, b: number) => b - a));
    });

    it("never exposes the mentor's User id", async () => {
      const res = await request(app.getHttpServer())
        .get('/mentors?limit=1')
        .set(auth(consumer))
        .expect(200);
      expect(res.body.items[0]).not.toHaveProperty('userId');
    });

    it('paginates without repeating or skipping rows', async () => {
      const first = await request(app.getHttpServer())
        .get('/mentors?limit=5')
        .set(auth(consumer))
        .expect(200);
      expect(first.body.nextCursor).toBeTruthy();

      const second = await request(app.getHttpServer())
        .get(`/mentors?limit=5&cursor=${encodeURIComponent(first.body.nextCursor)}`)
        .set(auth(consumer))
        .expect(200);

      const firstIds = first.body.items.map((m: { id: string }) => m.id);
      const secondIds = second.body.items.map((m: { id: string }) => m.id);
      expect(secondIds).toHaveLength(5);
      expect(firstIds.filter((id: string) => secondIds.includes(id))).toEqual([]);
    });

    it('rejects a malformed cursor instead of silently starting over', async () => {
      const res = await request(app.getHttpServer())
        .get('/mentors?cursor=notarealcursor')
        .set(auth(consumer))
        .expect(400);
      expect(res.body).toMatchObject({ code: 'INVALID_CURSOR' });
    });

    it('filters by category', async () => {
      const res = await request(app.getHttpServer())
        .get('/mentors?categorySlug=tarot&limit=10')
        .set(auth(consumer))
        .expect(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      for (const mentor of res.body.items) expect(mentor.categorySlug).toBe('tarot');
    });

    it('filters by price ceiling', async () => {
      const res = await request(app.getHttpServer())
        .get('/mentors?maxRatePaisePerMinute=2000&sort=PRICE_ASC&limit=10')
        .set(auth(consumer))
        .expect(200);
      for (const mentor of res.body.items) {
        expect(mentor.ratePaisePerMinute).toBeLessThanOrEqual(2000);
      }
    });

    it('404s an unknown category rather than returning everything', async () => {
      const res = await request(app.getHttpServer())
        .get('/mentors?categorySlug=does-not-exist')
        .set(auth(consumer))
        .expect(404);
      expect(res.body).toMatchObject({ code: 'CATEGORY_NOT_FOUND' });
    });
  });

  describe('apply → approve lifecycle', () => {
    let mentorProfileId: string;

    it('rejects a zero rate — a call that could never be cut off', async () => {
      const res = await request(app.getHttpServer())
        .post('/mentors/apply')
        .set(auth(applicant))
        .send({
          categorySlug: 'astrology',
          displayName: 'Zero Rate',
          languages: ['English'],
          experienceYears: 5,
          ratePaisePerMinute: 0,
        })
        .expect(400);
      expect(JSON.stringify(res.body.message)).toMatch(/ratePaisePerMinute/);
    });

    it('accepts a valid application and creates a PENDING profile', async () => {
      const res = await request(app.getHttpServer())
        .post('/mentors/apply')
        .set(auth(applicant))
        .send({
          categorySlug: 'astrology',
          displayName: 'E2E Applicant',
          headline: 'Testing the pipeline',
          languages: ['English', 'Hindi'],
          experienceYears: 7,
          ratePaisePerMinute: 2500,
        })
        .expect(201);

      expect(res.body).toMatchObject({ approvalStatus: 'PENDING', isBookable: false });
      mentorProfileId = res.body.id;
    });

    it('grants the MENTOR role immediately, without waiting for the cache to expire', async () => {
      // The apply flow invalidates the cached identity; without that this would 403.
      const res = await request(app.getHttpServer())
        .get('/mentors/me')
        .set(auth(applicant))
        .expect(200);
      expect(res.body.approvalStatus).toBe('PENDING');
    });

    it('keeps a pending mentor out of the catalogue', async () => {
      await request(app.getHttpServer())
        .get(`/mentors/${mentorProfileId}`)
        .set(auth(consumer))
        .expect(404);
    });

    it('refuses a second application', async () => {
      const res = await request(app.getHttpServer())
        .post('/mentors/apply')
        .set(auth(applicant))
        .send({
          categorySlug: 'tarot',
          displayName: 'Duplicate',
          languages: ['English'],
          experienceYears: 1,
          ratePaisePerMinute: 1000,
        })
        .expect(409);
      expect(res.body).toMatchObject({ code: 'MENTOR_PROFILE_EXISTS' });
    });

    it('requires a reason when rejecting', async () => {
      await request(app.getHttpServer())
        .post(`/admin/mentors/${mentorProfileId}/review`)
        .set(auth(adminUser))
        .send({ status: 'REJECTED' })
        .expect(400);
    });

    it('approves, and the mentor becomes visible and bookable', async () => {
      const review = await request(app.getHttpServer())
        .post(`/admin/mentors/${mentorProfileId}/review`)
        .set(auth(adminUser))
        .send({ status: 'APPROVED' })
        .expect(201);
      expect(review.body).toMatchObject({ approvalStatus: 'APPROVED', isBookable: true });

      const detail = await request(app.getHttpServer())
        .get(`/mentors/${mentorProfileId}`)
        .set(auth(consumer))
        .expect(200);
      expect(detail.body.displayName).toBe('E2E Applicant');
    });

    it('refuses to reject an already-approved mentor, directing to suspend instead', async () => {
      const res = await request(app.getHttpServer())
        .post(`/admin/mentors/${mentorProfileId}/review`)
        .set(auth(adminUser))
        .send({ status: 'REJECTED', note: 'changed my mind' })
        .expect(400);
      expect(res.body).toMatchObject({ code: 'USE_SUSPEND_INSTEAD' });
    });

    it('suspends, and the mentor leaves the catalogue immediately', async () => {
      await request(app.getHttpServer())
        .post(`/admin/mentors/${mentorProfileId}/review`)
        .set(auth(adminUser))
        .send({ status: 'SUSPENDED', note: 'Policy violation during e2e' })
        .expect(201);

      await request(app.getHttpServer())
        .get(`/mentors/${mentorProfileId}`)
        .set(auth(consumer))
        .expect(404);

      // The mentor can still see their own profile and why they were suspended.
      const mine = await request(app.getHttpServer())
        .get('/mentors/me')
        .set(auth(applicant))
        .expect(200);
      expect(mine.body).toMatchObject({
        approvalStatus: 'SUSPENDED',
        approvalNote: 'Policy violation during e2e',
        isBookable: false,
      });
    });
  });
});
