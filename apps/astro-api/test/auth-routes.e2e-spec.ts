import { INestApplication, RequestMethod, ValidationPipe } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
// `export =` module: a default import compiles to `.default`, which does not exist at runtime.
import * as request from 'supertest';

import { AppModule } from '../src/app/app.module';
import { IS_PUBLIC_KEY } from '../src/app/identity/contracts/decorators';

/**
 * The routes that are allowed to skip authentication. Adding to this list is a deliberate act
 * — it is the entire perimeter of the application, written down in one place.
 *
 * `@Public()` is easy to add and invisible in review; this test is what makes it loud.
 */
const PUBLIC_ROUTE_ALLOWLIST = [
  'GET /health',
  'GET /health/ready',
  // Authenticated by LiveKit JWT signature over the raw body, not a Firebase bearer token.
  'POST /webhooks/livekit',
].sort();

const methodName = (method: number): string => RequestMethod[method] ?? String(method);

const joinPath = (controllerPath: string, handlerPath: string): string => {
  const segments = [controllerPath, handlerPath]
    .map((segment) => (segment ?? '').replace(/^\/+|\/+$/g, ''))
    .filter((segment) => segment.length > 0);
  return `/${segments.join('/')}`;
};

describe('auth perimeter', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  /**
   * Walks every registered route and collects the ones the global guard will wave through.
   * Uses Nest's own metadata rather than poking at Express internals, which change between
   * major versions.
   */
  const collectPublicRoutes = (): string[] => {
    const discovery = app.get(DiscoveryService);
    const reflector = app.get(Reflector);
    const scanner = new MetadataScanner();
    const found: string[] = [];

    for (const wrapper of discovery.getControllers()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;

      const prototype = Object.getPrototypeOf(instance) as object;
      const controllerPath = (Reflect.getMetadata(PATH_METADATA, metatype) as string) ?? '';

      for (const method of scanner.getAllMethodNames(prototype)) {
        const handler = (prototype as Record<string, unknown>)[method] as (
          ...a: unknown[]
        ) => unknown;
        const httpMethod = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
        if (httpMethod === undefined) continue;

        const isPublic = reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
          handler,
          metatype as never,
        ]);
        if (!isPublic) continue;

        const handlerPath = (Reflect.getMetadata(PATH_METADATA, handler) as string) ?? '';
        found.push(`${methodName(httpMethod)} ${joinPath(controllerPath, handlerPath)}`);
      }
    }

    return found.sort();
  };

  it('exposes exactly the allowlisted public routes and nothing else', () => {
    expect(collectPublicRoutes()).toEqual(PUBLIC_ROUTE_ALLOWLIST);
  });

  it('registers at least one route, so a broken bootstrap cannot pass vacuously', () => {
    const controllers = app.get(DiscoveryService).getControllers();
    expect(controllers.length).toBeGreaterThan(0);
  });

  describe('guarded routes', () => {
    it('rejects a request with no Authorization header', async () => {
      const res = await request(app.getHttpServer()).get('/me').expect(401);
      expect(res.body).toMatchObject({ code: 'MISSING_TOKEN', statusCode: 401 });
    });

    it('rejects a non-Bearer Authorization header', async () => {
      const res = await request(app.getHttpServer())
        .get('/me')
        .set('Authorization', 'Basic aGk6dGhlcmU=')
        .expect(401);
      expect(res.body).toMatchObject({ code: 'MISSING_TOKEN' });
    });

    it('rejects a forged bearer token', async () => {
      const res = await request(app.getHttpServer())
        .get('/me')
        .set('Authorization', 'Bearer not.a.real.token')
        .expect(401);
      expect(res.body).toMatchObject({ code: 'INVALID_TOKEN' });
    });

    it('does not disclose why a token failed', async () => {
      const res = await request(app.getHttpServer())
        .get('/me')
        .set('Authorization', 'Bearer not.a.real.token')
        .expect(401);
      // "expired" vs "forged" would tell an attacker which of the two they achieved.
      expect(res.body.message).toBe('Invalid or expired token');
    });
  });

  describe('public routes', () => {
    it('serves liveness with no credentials', async () => {
      await request(app.getHttpServer()).get('/health').expect(200);
    });

    it('serves readiness with no credentials', async () => {
      const res = await request(app.getHttpServer()).get('/health/ready').expect(200);
      expect(res.body.info).toMatchObject({
        database: { status: 'up' },
        redis: { status: 'up' },
      });
    });
  });
});
