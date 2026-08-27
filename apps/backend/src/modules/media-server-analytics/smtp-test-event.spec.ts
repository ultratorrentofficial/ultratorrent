import { BadRequestException } from '@nestjs/common';
import { MediaServerEmailService } from './media-server-email.service';

/** Builds the service with a transport that succeeds, or fails with `failWith`. */
function harness(failWith?: string) {
  const record = jest.fn(async () => undefined);
  const mail = {
    send: jest.fn(async () => {
      if (failWith) throw new Error(failWith);
    }),
  };
  const svc = new MediaServerEmailService(mail as any, { record } as any);
  return { svc, record, mail };
}

const only = (record: jest.Mock) => record.mock.calls[0][0];

describe('the SMTP settings test records what happened', () => {
  it('records a delivered test against no particular newsletter', async () => {
    /*
     * `newsletterId: null` is the point: this checks the platform transport, so
     * it belongs in the feed spanning every newsletter and NOT in the history of
     * one that it says nothing about.
     */
    const { svc, record } = harness();

    await expect(svc.testEmail('someone@example.com')).resolves.toEqual({ ok: true });

    expect(only(record)).toMatchObject({
      newsletterId: null, eventType: 'test_sent', level: 'success',
      messageKey: 'newsletter.event.smtpTestSent',
      metadata: expect.objectContaining({ outcome: 'sent', scope: 'smtp_settings' }),
    });
  });

  it('records a failed test with its reason', async () => {
    const { svc, record } = harness('Connection timeout');

    await expect(svc.testEmail('someone@example.com')).rejects.toThrow(BadRequestException);

    expect(only(record)).toMatchObject({
      newsletterId: null, eventType: 'test_sent', level: 'error',
      sanitizedMessage: 'Connection timeout',
    });
  });

  it('reports the SMTP reason rather than a bare 500', async () => {
    // This is the screen an operator is on while CHANGING the settings, so the
    // reason is the whole value of the button.
    const { svc } = harness("Hostname/IP does not match certificate's altnames");

    await expect(svc.testEmail('someone@example.com')).rejects.toThrow(/altnames/);
  });

  it('refuses an empty recipient without touching the transport', async () => {
    const { svc, record, mail } = harness();

    await expect(svc.testEmail('   ')).rejects.toThrow(BadRequestException);

    expect(mail.send).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});
