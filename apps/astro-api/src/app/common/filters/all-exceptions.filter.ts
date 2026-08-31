import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { isDomainError } from '@astro/errors';
import type { Request, Response } from 'express';

interface ErrorBody {
  statusCode: number;
  /** Stable, machine-readable. Clients branch on this, never on `message`. */
  code: string;
  message: string | string[];
  details?: Readonly<Record<string, unknown>>;
  path: string;
  timestamp: string;
}

/**
 * The single HTTP error envelope, registered as `APP_FILTER`.
 *
 * The `DomainError` branch is the point of this file. In the reference repo a `DomainError`
 * base class existed but no filter ever mapped it, so every use case reached for Nest's HTTP
 * exceptions instead and the domain layer ended up importing `@nestjs/common`. Mapping it
 * here on day one is what keeps `application/` and `domain/` free of HTTP concerns.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionsFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    // WebSocket and RPC contexts are deliberately untouched: gateways answer with a
    // discriminated-union ack, and rewriting that into an HTTP shape would break the contract.
    if (host.getType() !== 'http') return;

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const body = this.toBody(exception, request.url);

    if (body.statusCode >= 500) {
      this.logger.error(
        `${request.method} ${request.url} -> ${body.statusCode}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown, path: string): ErrorBody {
    const timestamp = new Date().toISOString();

    if (isDomainError(exception)) {
      return {
        statusCode: exception.httpStatus,
        code: exception.code,
        message: exception.message,
        ...(exception.details ? { details: exception.details } : {}),
        path,
        timestamp,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      // ValidationPipe returns `{ statusCode, message: string[], error }`; preserve the array
      // so clients can surface per-field errors.
      const message =
        typeof payload === 'object' && payload !== null && 'message' in payload
          ? ((payload as { message: string | string[] }).message ?? exception.message)
          : exception.message;

      return {
        statusCode: status,
        code: HttpStatus[status] ?? 'HTTP_ERROR',
        message,
        path,
        timestamp,
      };
    }

    // Never leak internal error text — an unhandled exception's message can contain a
    // connection string, a query, or a token.
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
      path,
      timestamp,
    };
  }
}
