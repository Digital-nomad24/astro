import { randomUUID } from 'node:crypto';

import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

const isProd = process.env.NODE_ENV === 'production';

/**
 * Structured application logging.
 *
 * Production emits one JSON object per event, which is what Cloud Logging ingests and what
 * makes the money-path audit trail queryable (`billing.charge.*`, `livekit.webhook.*`).
 * Development pretty-prints. Every HTTP request is auto-logged with a correlation id.
 *
 * Read directly from `process.env` rather than `ConfigService`: this module is constructed
 * before `ConfigModule` finishes validating, and logging must work even when config fails.
 */
@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
        transport: isProd ? undefined : { target: 'pino-pretty', options: { singleLine: true } },
        autoLogging: true,
        genReqId: (req, res) => {
          const existing = req.headers['x-request-id'];
          const id = (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID();
          res.setHeader('x-request-id', id);
          return id;
        },
        // A bearer token in a log line is a credential in a log aggregator, forever.
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["x-livekit-signature"]',
          ],
          remove: true,
        },
        customProps: () => ({ context: 'HTTP' }),
      },
    }),
  ],
  exports: [LoggerModule],
})
export class LoggingModule {}
