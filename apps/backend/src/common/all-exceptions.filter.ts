import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * Global HTTP exception filter. Preserves Nest's HttpException responses (so
 * validation messages / 4xx bodies are unchanged) but funnels unknown errors
 * to a generic 500 — never leaking a stack trace or internal detail to the
 * client — and logs 5xx server-side with the stack for diagnosis.
 *
 * With one carve-out: an error that already carries its own HTTP status is not
 * an unknown error, and flattening it to 500 throws away the only useful thing
 * about it. body-parser's `PayloadTooLargeError` is the case that proved it —
 * a rules-bundle import over the body limit reported "Internal server error",
 * which reads as a crash and gave the operator nothing to act on when the real
 * answer was "the file is too big".
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    // Only handle HTTP; let other transports (WS) use their own handling.
    if (host.getType() !== 'http') throw exception;

    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const isHttp = exception instanceof HttpException;
    // Errors from Express middleware (body-parser above all) are plain Errors
    // carrying a `status`/`statusCode`. Honour a 4xx they state about themselves.
    const declared = declaredClientStatus(exception);
    const status = isHttp ? exception.getStatus() : (declared ?? 500);

    if (status >= 500) {
      this.logger.error(
        `${req.method} ${req.originalUrl} -> ${status}: ${(exception as Error)?.message}`,
        (exception as Error)?.stack,
      );
    }

    const body = isHttp
      ? exception.getResponse()
      : declared
        ? { statusCode: declared, message: clientMessage(exception, declared) }
        : { statusCode: 500, message: 'Internal server error' };
    res.status(status).json(typeof body === 'string' ? { statusCode: status, message: body } : body);
  }
}

/**
 * The 4xx an Express-layer error states about itself, or null.
 *
 * Deliberately 4xx only: a 5xx from an unknown error is exactly the case whose
 * detail must not reach the client, and this must not become a way for arbitrary
 * internals to leak a message.
 */
function declaredClientStatus(exception: unknown): number | null {
  const e = exception as { status?: unknown; statusCode?: unknown };
  const raw = typeof e?.status === 'number' ? e.status : e?.statusCode;
  return typeof raw === 'number' && raw >= 400 && raw < 500 ? raw : null;
}

/** A message the operator can act on, without echoing internals. */
function clientMessage(exception: unknown, status: number): string {
  const type = (exception as { type?: string })?.type;
  if (status === 413 || type === 'entity.too.large') {
    return 'The uploaded file is too large for this endpoint.';
  }
  if (type === 'entity.parse.failed') return 'The uploaded file is not valid JSON.';
  return (exception as Error)?.message || 'Request rejected.';
}
