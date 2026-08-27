import { BadRequestException } from '@nestjs/common';
import { MediaServerNewsletterService } from './media-server-newsletter.service';

jest.mock('./newsletter-render', () => ({
  ...jest.requireActual('./newsletter-render'),
  renderHtml: () => '<html/>',
  renderText: () => 'text',
}));

const NEWSLETTER = { id: 'nl-1', name: 'Movies', subjectTemplate: null, recipientEmails: [] };

/** Builds the service with a send that either succeeds or fails with `failWith`. */
function harness(failWith?: string) {
  const record = jest.fn(async () => undefined);
  const auditRecord = jest.fn(async () => undefined);
  const prisma = { mediaServerNewsletter: { findUnique: jest.fn(async () => NEWSLETTER) } };
  const email = {
    send: jest.fn(async () => {
      if (failWith) throw new Error(failWith);
    }),
  };
  const svc = new MediaServerNewsletterService(
    prisma as any,
    email as any,
    { record: auditRecord } as any,
    { record, newRun: () => 'run', endRun: jest.fn(), prune: jest.fn(async () => undefined) } as any,
    { broadcast: jest.fn() } as any,
    {} as any, {} as any, {} as any,
    { get: jest.fn(async () => undefined) } as any,
  );
  (svc as any).build = jest.fn(async () => ({
    content: { sections: [], totalItems: 1, since: new Date(), until: new Date() },
    attachments: [], opts: {},
  }));
  return { svc, record, auditRecord };
}

/** The single event the call recorded. */
const only = (record: jest.Mock) => record.mock.calls[0][0];

describe('a newsletter test send records what happened', () => {
  it('records a successful test, so the activity view can show it', async () => {
    // `test_sent` was in the event union from the start and nothing ever emitted
    // it: testing an SMTP change left the feed empty.
    const { svc, record } = harness();

    await svc.testSend('nl-1', 'someone@example.com');

    expect(record).toHaveBeenCalledTimes(1);
    expect(only(record)).toMatchObject({
      newsletterId: 'nl-1', eventType: 'test_sent', level: 'success',
      metadata: expect.objectContaining({ recipient: 'someone@example.com', outcome: 'sent' }),
    });
  });

  it('records a FAILED test, carrying the reason', async () => {
    const { svc, record } = harness('Hostname/IP does not match certificate\'s altnames');

    await expect(svc.testSend('nl-1', 'someone@example.com')).rejects.toThrow(BadRequestException);

    expect(only(record)).toMatchObject({
      eventType: 'test_sent', level: 'error',
      sanitizedMessage: expect.stringContaining('altnames'),
    });
  });

  it('surfaces the SMTP reason instead of a bare 500', async () => {
    /*
     * The error used to escape raw, so Nest mapped it to 500 "Internal server
     * error" and the one fact worth having stayed in the container log.
     */
    const { svc } = harness('Connection timeout');

    await expect(svc.testSend('nl-1', 'someone@example.com')).rejects.toThrow('Connection timeout');
  });

  it('does not audit a test that never arrived', async () => {
    // The audit call sat after the send, so a failure recorded nothing anywhere.
    // It still must not claim a test was sent — the EVENT is what covers failure.
    const { svc, auditRecord } = harness('Connection timeout');

    await expect(svc.testSend('nl-1', 'someone@example.com')).rejects.toThrow();

    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('still refuses an empty recipient before doing any work', async () => {
    const { svc, record } = harness();

    await expect(svc.testSend('nl-1', '')).rejects.toThrow(BadRequestException);

    expect(record).not.toHaveBeenCalled();
  });
});
