import { NewsletterEventsService } from './newsletter-events.service';

/*
 * A send writes one event per recipient, so a feed of raw events is two hundred
 * near-identical lines. The run is the unit an operator thinks in — "did
 * tonight's newsletter go out" — so the run's OUTCOME leads the entry and
 * everything else hangs beneath it.
 */

type Row = Record<string, unknown>;

function svc(rows: Row[]) {
  return new NewsletterEventsService({
    mediaServerNewsletterEvent: {
      findMany: async () => rows,
      create: async () => undefined,
      deleteMany: async () => undefined,
    },
  } as never);
}

const at = (s: string) => new Date(s);
const ev = (over: Row = {}): Row => ({
  id: 'e1', newsletterId: 'n1', runId: 'run1', sequence: 1,
  level: 'info', eventType: 'generated', messageKey: null, messageParams: null,
  sanitizedMessage: null, metadata: null, createdAt: at('2026-08-27T01:00:00Z'),
  ...over,
});

describe('newsletter activity', () => {
  it('collapses a run into one entry led by its outcome', async () => {
    const entries = await svc([
      ev({ id: 'a', sequence: 1, eventType: 'generated' }),
      ev({ id: 'b', sequence: 2, eventType: 'send_started' }),
      ev({ id: 'c', sequence: 3, eventType: 'recipient_sent', level: 'success' }),
      ev({ id: 'd', sequence: 4, eventType: 'send_completed', level: 'success' }),
    ]).activity();

    expect(entries).toHaveLength(1);
    expect(entries[0].eventType).toBe('send_completed');
    // Everything else is available under it, oldest first, so the expanded row
    // reads as the sequence of what happened.
    expect(entries[0].events.map((e) => e.eventType)).toEqual([
      'generated', 'send_started', 'recipient_sent',
    ]);
  });

  it('leads with the failure when a send failed outright', async () => {
    const entries = await svc([
      ev({ id: 'a', sequence: 1, eventType: 'generated' }),
      ev({ id: 'b', sequence: 2, eventType: 'recipient_failed', level: 'error' }),
      ev({ id: 'c', sequence: 3, eventType: 'send_failed', level: 'error' }),
    ]).activity();

    expect(entries[0].eventType).toBe('send_failed');
    expect(entries[0].level).toBe('error');
  });

  /*
   * A run cut short — the process restarted mid-send — has no conclusion. It
   * still has to appear, and appear as what it is, rather than vanish because
   * the event the grouping looks for was never written.
   */
  it('still shows a run that never finished', async () => {
    const entries = await svc([
      ev({ id: 'a', sequence: 1, eventType: 'generated' }),
      ev({ id: 'b', sequence: 2, eventType: 'send_started' }),
    ]).activity();

    expect(entries).toHaveLength(1);
    expect(entries[0].eventType).toBe('send_started');
    expect(entries[0].events.map((e) => e.eventType)).toEqual(['generated']);
  });

  it('keeps runs apart', async () => {
    const entries = await svc([
      ev({ id: 'a', runId: 'r1', sequence: 1, eventType: 'send_completed', createdAt: at('2026-08-27T02:00:00Z') }),
      ev({ id: 'b', runId: 'r2', sequence: 1, eventType: 'send_failed', createdAt: at('2026-08-27T03:00:00Z') }),
    ]).activity();

    expect(entries).toHaveLength(2);
    // Newest first, like every other feed in the product.
    expect(entries[0].eventType).toBe('send_failed');
  });

  /*
   * A scheduled dispatch that threw has no run at all — the failure happened
   * before a run could start. It is the single most important thing this
   * feature had to surface, so it cannot be dropped for lacking a run id.
   */
  it('shows an event that belongs to no run', async () => {
    const entries = await svc([
      ev({ id: 'x', runId: null, sequence: 0, eventType: 'send_failed', level: 'error',
           sanitizedMessage: 'SMTP timeout' }),
    ]).activity();

    expect(entries).toHaveLength(1);
    expect(entries[0].events).toEqual([]);
    expect(entries[0].sanitizedMessage).toBe('SMTP timeout');
  });

  it('orders events within a run by sequence, not by insertion', async () => {
    const entries = await svc([
      ev({ id: 'c', sequence: 3, eventType: 'send_completed' }),
      ev({ id: 'a', sequence: 1, eventType: 'generated' }),
      ev({ id: 'b', sequence: 2, eventType: 'send_started' }),
    ]).activity();

    expect(entries[0].events.map((e) => e.eventType)).toEqual(['generated', 'send_started']);
  });

  it('never lets a recording failure escape', async () => {
    const broken = new NewsletterEventsService({
      mediaServerNewsletterEvent: { create: async () => { throw new Error('db down'); } },
    } as never);
    // A newsletter that sent correctly must not be reported as failed because
    // the note about it could not be written.
    await expect(broken.record({ level: 'info', eventType: 'generated' })).resolves.toBeUndefined();
  });
});
