import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Redis } from 'ioredis';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app/app.module';
import { REDIS_CLIENT } from './app/infra/redis/redis.tokens';
import type { EnvVars } from './config/env.schema';
import { RedisIoAdapter } from './config/redis-io.adapter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // Preserves the unparsed request body on `req.rawBody`. Required for LiveKit webhook
    // signature verification (M4) — a signature is over the exact bytes sent, and any
    // re-serialisation of the parsed object changes them.
    rawBody: true,
  });

  app.useLogger(app.get(Logger));
  // Fires OnModuleDestroy / OnApplicationShutdown (Prisma $disconnect, Redis quit, gateway
  // timers) on SIGTERM — which is how Cloud Run ends a revision.
  app.enableShutdownHooks();

  // LiveKit posts webhooks as `application/webhook+json`, NOT `application/json`. Express's
  // default JSON parser ignores that content type and hands the handler an empty body, so the
  // signature check would fail — or worse, silently pass over nothing. Widening the parser
  // here rather than in the controller means the raw-body plumbing is set up once, at the
  // only place that can do it.
  app.useBodyParser('json', {
    type: ['application/json', 'application/webhook+json'],
    limit: '1mb',
  });

  const config = app.get(ConfigService<EnvVars, true>);

  // Multi-instance mode. With the adapter, rooms and `server.to(room).emit(...)` span every
  // instance; without it, an emit on one instance never reaches sockets on another. The env
  // schema already refuses to let this be disabled in production.
  if (config.get('REDIS_ADAPTER_ENABLED', { infer: true })) {
    const adapter = new RedisIoAdapter(app, app.get<Redis>(REDIS_CLIENT));
    // Must be awaited before `useWebSocketAdapter`: `createIOServer` reads the adapter
    // constructor, so an un-awaited connect silently yields a non-Redis server.
    await adapter.connect();
    app.useWebSocketAdapter(adapter);
  } else {
    app.useWebSocketAdapter(new IoAdapter(app));
  }

  const corsRaw = config.get('CORS_ORIGINS', { infer: true });
  const webOrigin = config.get('WEB_APP_ORIGIN', { infer: true });
  const corsOrigins = [
    ...(corsRaw
      ? corsRaw
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean)
      : [
          'http://localhost:5173',
          'http://127.0.0.1:5173',
          'https://89b1-103-87-57-22.ngrok-free.app',
        ]),
    ...(webOrigin ? [webOrigin] : []),
  ].filter((origin, index, all) => all.indexOf(origin) === index);

  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-Id',
      'ngrok-skip-browser-warning',
    ],
  });

  // Note this does NOT apply to WebSocket message bodies — each gateway declares its own
  // `@UsePipes(ValidationPipe)`.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  if (config.get('ENABLE_SWAGGER', { infer: true })) {
    const openapi = new DocumentBuilder()
      .setTitle('Astro API')
      .setDescription('Mentor consultation platform — voice and text sessions, wallet-billed.')
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'firebase')
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, openapi));
  }

  await app.listen(config.get('PORT', { infer: true }));
}

void bootstrap();
