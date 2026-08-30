import { MediaServerNewsletterService } from './media-server-newsletter.service';

/*
 * Rendering has its own suites; these tests are about what a send RECORDS about
 * itself, so the templates are stubbed out to keep the subject narrow.
 */
jest.mock('./newsletter-render', () => ({
  ...jest.requireActual('./newsletter-render'),
  renderHtml: () => '<html/>',
  renderText: () => 'text',
}));

const NEWSLETTER = {
  id: 'nl-1',
  name: 'Movies',
  subjectTemplate: null,
  recipientEmails: ['a@example.com', 'b@example.com'],
  frequency: 'weekly',
  sendWeekday: 5,
  sendHour: 12,
  sendMinute: 0,
  timezone: 'America/Puerto_Rico',
  dateRangeMode: 'last_days',
  lastDays: 7,
  lastSuccessfulSendAt: new Date('2026-08-14T16:00:00Z'),
};

/**
 * Builds the service with everything stubbed, and hands back the `update` mock
 * so a test can read what the send wrote to the newsletter row.
 *
 * `send` decides each recipient's fate: it throws for any address in `refuse`.
 */
function harness(refuse: string[]) {
  const update = jest.fn(async () => NEWSLETTER);
  const prisma = {
    mediaServerNewsletter: {
      findUnique: jest.fn(async () => NEWSLETTER),
      update,
    },
    mediaServerNewsletterDelivery: { create: jest.fn(async () => ({})) },
  };
  const email = {
    isConfigured: jest.fn(async () => true),
    send: jest.fn(async ({ to }: { to: string }) => {
      if (refuse.includes(to)) throw new Error('Connection timeout');
    }),
  };
  const events = {
    newRun: () => 'run_test',
    record: jest.fn(async () => undefined),
    endRun: jest.fn(),
    prune: jest.fn(async () => undefined),
  };
  const svc = new MediaServerNewsletterService(
    prisma as any,
    email as any,
    { record: jest.fn(async () => undefined) } as any,
    events as any,
    { broadcast: jest.fn() } as any,
    {} as any,
    { effectiveMode: jest.fn(async () => ({ mode: 'proxy', publicBaseUrl: '' })) } as any,
    {} as any,
    { get: jest.fn(async () => undefined) } as any,
    { token: jest.fn(() => 'tok'), url: jest.fn(() => 'https://x/unsub') } as any,
    { baseUrl: async () => null } as any, // publicUrl
  );
  // The generation is exercised elsewhere; this suite is about the outcome.
  (svc as any).build = jest.fn(async () => ({
    content: { sections: [], totalItems: 3, since: new Date(), until: new Date() },
    attachments: [],
    opts: {},
  }));
  return { svc, update };
}

/** What the send wrote to the newsletter row. */
const written = (update: jest.Mock) => update.mock.calls[0][0].data;

describe('what a send records about itself', () => {
  it('does not date a send successful when it reached NOBODY', async () => {
    /*
     * The live case this comes from: 45 recipients, every one refused with
     * "Connection timeout", and both newsletters still showed "last sent" as
     * that day — the one field an operator checks to answer "did it go out".
     */
    const { svc, update } = harness(['a@example.com', 'b@example.com']);

    const result = await svc.sendNow('nl-1');

    expect(result).toEqual({ sent: 0, failed: 2 });
    expect(written(update)).not.toHaveProperty('lastSuccessfulSendAt');
  });

  it('still advances the schedule after a total failure', async () => {
    /*
     * The dispatch sweep selects on `nextRunAt <= now` every 15 minutes, so a
     * cadence held back on failure would re-send to every recipient four times
     * an hour against a mail server already refusing us.
     */
    const { svc, update } = harness(['a@example.com', 'b@example.com']);

    await svc.sendNow('nl-1');

    expect(written(update).nextRunAt).toBeInstanceOf(Date);
    expect(written(update).nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('dates the send when a recipient actually received it', async () => {
    const { svc, update } = harness([]);

    const result = await svc.sendNow('nl-1');

    expect(result).toEqual({ sent: 2, failed: 0 });
    expect(written(update).lastSuccessfulSendAt).toBeInstanceOf(Date);
  });

  it('counts a partial send as sent, because somebody got it', async () => {
    /*
     * `since_last_send` reads this field as the content window's start, so
     * withholding it here would re-send to the recipient who DID receive the
     * edition. One delivery is enough to close the window.
     */
    const { svc, update } = harness(['b@example.com']);

    const result = await svc.sendNow('nl-1');

    expect(result).toEqual({ sent: 1, failed: 1 });
    expect(written(update).lastSuccessfulSendAt).toBeInstanceOf(Date);
  });
});
