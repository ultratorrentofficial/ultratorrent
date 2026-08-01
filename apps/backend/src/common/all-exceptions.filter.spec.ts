import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

/**
 * What the client is told when something goes wrong.
 *
 * The filter has two jobs in tension: never leak internals from an unknown
 * error, and never hide a cause the operator could act on. It shipped doing only
 * the first — an RSS rules bundle over the body limit surfaced as "500 Internal
 * server error", which reads as a crash. The real answer was "the file is too
 * big", and nothing in the response said so.
 */
function build() {
  const sent: Array<{ status: number; body: unknown }> = [];
  const res = {
    status(code: number) {
      return { json: (body: unknown) => { sent.push({ status: code, body }); } };
    },
  };
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ method: 'POST', originalUrl: '/api/rss/rules-import' }),
    }),
  };
  const filter = new AllExceptionsFilter();
  // Silence the 5xx logging; this file is about the response, not the log.
  jest.spyOn((filter as never as { logger: { error: () => void } }).logger, 'error')
    .mockImplementation(() => undefined);
  return { filter, host, sent };
}

/** What body-parser actually throws: a plain Error carrying status and type. */
const payloadTooLarge = () =>
  Object.assign(new Error('request entity too large'), {
    status: 413,
    statusCode: 413,
    type: 'entity.too.large',
  });

describe('AllExceptionsFilter', () => {
  it('reports an oversized body as 413, not a generic 500', () => {
    const { filter, host, sent } = build();
    filter.catch(payloadTooLarge(), host as never);

    expect(sent[0].status).toBe(413);
    expect((sent[0].body as { message: string }).message).toMatch(/too large/i);
  });

  it('says something the operator can act on', () => {
    // "Internal server error" sent them looking for a crash. The file was big.
    const { filter, host, sent } = build();
    filter.catch(payloadTooLarge(), host as never);

    expect((sent[0].body as { message: string }).message).not.toMatch(/internal server error/i);
  });

  it('names malformed JSON as malformed JSON', () => {
    const { filter, host, sent } = build();
    filter.catch(
      Object.assign(new Error('Unexpected token'), { status: 400, type: 'entity.parse.failed' }),
      host as never,
    );
    expect(sent[0].status).toBe(400);
    expect((sent[0].body as { message: string }).message).toMatch(/not valid JSON/i);
  });

  it('STILL hides an unknown error behind a generic 500', () => {
    /*
     * The half that must not regress. An ordinary Error has no business
     * reaching the client — its message is as likely to be a connection string
     * as anything useful.
     */
    const { filter, host, sent } = build();
    filter.catch(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'), host as never);

    expect(sent[0].status).toBe(500);
    expect(sent[0].body).toEqual({ statusCode: 500, message: 'Internal server error' });
  });

  it('does not honour a 5xx an error claims about itself', () => {
    // Only 4xx is trusted: a self-declared 500 is exactly the case whose detail
    // must not escape, so it must not become a channel for leaking one.
    const { filter, host, sent } = build();
    filter.catch(Object.assign(new Error('internal detail'), { status: 503 }), host as never);

    expect(sent[0].status).toBe(500);
    expect((sent[0].body as { message: string }).message).toBe('Internal server error');
  });

  it('leaves a Nest HttpException entirely alone', () => {
    // Validation messages and deliberate 4xx bodies must pass through unchanged.
    const { filter, host, sent } = build();
    filter.catch(new BadRequestException('That path is already used by "Silo".'), host as never);

    expect(sent[0].status).toBe(HttpStatus.BAD_REQUEST);
    expect((sent[0].body as { message: string }).message).toBe('That path is already used by "Silo".');
  });

  it('normalises a string HttpException body into an object', () => {
    const { filter, host, sent } = build();
    filter.catch(new HttpException('plain string', HttpStatus.FORBIDDEN), host as never);

    expect(sent[0].body).toEqual({ statusCode: 403, message: 'plain string' });
  });
});
