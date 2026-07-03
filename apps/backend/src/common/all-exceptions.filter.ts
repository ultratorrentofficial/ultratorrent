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
    const status = isHttp ? exception.getStatus() : 500;

    if (status >= 500) {
      this.logger.error(
        `${req.method} ${req.originalUrl} -> ${status}: ${(exception as Error)?.message}`,
        (exception as Error)?.stack,
      );
    }

    const body = isHttp
      ? exception.getResponse()
      : { statusCode: 500, message: 'Internal server error' };
    res.status(status).json(typeof body === 'string' ? { statusCode: status, message: body } : body);
  }
}
