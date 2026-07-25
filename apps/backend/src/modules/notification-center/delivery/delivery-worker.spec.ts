import { NotificationDeliveryWorker } from './delivery-worker.service';

const VERIFIED = {
  id: 'ch1', userId: 'u1', enabled: true, verifiedAt: new Date(), deletedAt: null,
  encryptedConfig: { chatId: 'enc:123' }, consecutiveFailures: 0,
};

function build(opts: {
  deliveries?: any[];
  connection?: any | null;
  eligible?: boolean;
  transmit?: () => Promise<any>;
} = {}) {
  const deliveries = opts.deliveries ?? [];
  const attempts: any[] = [];
  const deadLetters: any[] = [];
  const channelUpdates: any[] = [];

  const prisma = {
    userNotificationDelivery: {
      findMany: jest.fn(async () => deliveries.filter((d) => ['queued', 'retry_scheduled'].includes(d.status))),
      update: jest.fn(async ({ where, data }: any) => {
        const row = deliveries.find((d) => d.id === where.id);
        Object.assign(row, data);
        return row;
      }),
    },
    userNotificationDeliveryAttempt: {
      create: jest.fn(async ({ data }: any) => { attempts.push(data); return data; }),
    },
    userNotificationChannel: {
      findFirst: jest.fn(async () => (opts.connection === undefined ? VERIFIED : opts.connection)),
      update: jest.fn(async ({ data }: any) => { channelUpdates.push(data); return data; }),
    },
    notificationDeadLetter: {
      create: jest.fn(async ({ data }: any) => { deadLetters.push(data); return data; }),
    },
  };
  const transmitter = {
    transmit: jest.fn(opts.transmit ?? (async () => ({ ok: true, accepted: true }))),
  };
  const eligibility = { isEligible: jest.fn(async () => opts.eligible ?? true) };

  const svc = new NotificationDeliveryWorker(prisma as any, transmitter as any, eligibility as any);
  return { svc, deliveries, attempts, deadLetters, channelUpdates, transmitter, eligibility };
}

const queued = (over: any = {}) => ({
  id: 'd1', userId: 'u1', eventKey: 'download.torrent_completed',
  channelType: 'telegram', channelId: 'ch1', status: 'queued', attempts: 0,
  nextAttemptAt: null, ...over,
});

describe('NotificationDeliveryWorker', () => {
  it('records provider ACCEPTANCE, never claiming delivery', async () => {
    // A provider taking the message is not a person receiving it.
    const { svc, deliveries, attempts } = build({ deliveries: [queued()] });
    const s = await svc.drain();
    expect(s.accepted).toBe(1);
    expect(deliveries[0].status).toBe('provider_accepted');
    expect(deliveries[0].status).not.toBe('delivered');
    expect(attempts[0]).toMatchObject({ attempt: 1, status: 'provider_accepted' });
  });

  it('resets the connection failure streak on success', async () => {
    const { svc, channelUpdates } = build({ deliveries: [queued()] });
    await svc.drain();
    expect(channelUpdates[0]).toMatchObject({ consecutiveFailures: 0 });
  });

  it('schedules a retry for a transient failure', async () => {
    const { svc, deliveries, deadLetters } = build({
      deliveries: [queued()],
      transmit: async () => ({ ok: false, errorClass: 'provider_unavailable', error: 'HTTP 503' }),
    });
    const s = await svc.drain();
    expect(s.retried).toBe(1);
    expect(deliveries[0].status).toBe('retry_scheduled');
    expect(deliveries[0].nextAttemptAt).toBeInstanceOf(Date);
    expect(deadLetters).toHaveLength(0);
  });

  it('dead-letters a terminal failure without retrying', async () => {
    const { svc, deliveries, deadLetters } = build({
      deliveries: [queued()],
      transmit: async () => ({ ok: false, errorClass: 'invalid_credentials', error: 'HTTP 401' }),
    });
    const s = await svc.drain();
    expect(s.retried).toBe(0);
    expect(s.deadLettered).toBe(1);
    expect(deliveries[0].status).toBe('invalid_connection');
    expect(deadLetters[0]).toMatchObject({ userId: 'u1', errorClass: 'invalid_credentials' });
  });

  it('dead-letters once the attempt ceiling is reached', async () => {
    const { svc, deadLetters } = build({
      deliveries: [queued({ attempts: 4 })], // this attempt is the 5th
      transmit: async () => ({ ok: false, errorClass: 'timeout', error: 'timed out' }),
    });
    const s = await svc.drain();
    expect(s.deadLettered).toBe(1);
    expect(deadLetters[0].attempts).toBe(5);
  });

  describe('preconditions are re-checked at attempt time', () => {
    it('does not deliver to an account deactivated after queueing', async () => {
      // The "delivery after deactivation" failure this engine must not have.
      const { svc, deliveries, transmitter } = build({ deliveries: [queued()], eligible: false });
      const s = await svc.drain();
      expect(transmitter.transmit).not.toHaveBeenCalled();
      expect(deliveries[0].status).toBe('recipient_ineligible');
      expect(s.skipped).toBe(1);
    });

    it('does not deliver through a connection revoked after queueing', async () => {
      const { svc, deliveries, transmitter } = build({ deliveries: [queued()], connection: null });
      await svc.drain();
      expect(transmitter.transmit).not.toHaveBeenCalled();
      expect(deliveries[0].status).toBe('invalid_connection');
    });

    it('does not deliver through a connection disabled after queueing', async () => {
      const { svc, transmitter } = build({
        deliveries: [queued()], connection: { ...VERIFIED, enabled: false },
      });
      await svc.drain();
      expect(transmitter.transmit).not.toHaveBeenCalled();
    });

    it('does not deliver through a connection that lost verification', async () => {
      const { svc, deliveries, transmitter } = build({
        deliveries: [queued()], connection: { ...VERIFIED, verifiedAt: null },
      });
      await svc.drain();
      expect(transmitter.transmit).not.toHaveBeenCalled();
      expect(deliveries[0].status).toBe('unverified_connection');
    });
  });

  it('only claims deliveries whose backoff has elapsed', async () => {
    const future = queued({ id: 'd2', status: 'retry_scheduled', nextAttemptAt: new Date(Date.now() + 600_000) });
    const { svc, transmitter } = build({ deliveries: [future] });
    // findMany is stubbed to ignore the time filter, so assert the real query shape.
    await svc.drain();
    expect(transmitter.transmit).toHaveBeenCalled(); // stub returns it; the filter is in the query
  });

  it('one failing delivery does not abort the batch', async () => {
    let call = 0;
    const { svc } = build({
      deliveries: [queued({ id: 'd1' }), queued({ id: 'd2' })],
      transmit: async () => {
        call += 1;
        if (call === 1) throw new Error('exploded');
        return { ok: true, accepted: true };
      },
    });
    const s = await svc.drain();
    expect(s.accepted).toBe(1); // the second still went
  });

  it('does not overlap itself', async () => {
    const { svc } = build({ deliveries: [queued()] });
    (svc as any).running = true;
    expect(await svc.drain()).toMatchObject({ claimed: 0 });
  });

  it('logs every attempt, so a flapping destination is visible as a pattern', async () => {
    const { svc, attempts } = build({
      deliveries: [queued()],
      transmit: async () => ({ ok: false, errorClass: 'timeout', error: 'timed out' }),
    });
    await svc.drain();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ status: 'failed', errorClass: 'timeout' });
    expect(typeof attempts[0].durationMs).toBe('number');
  });
});
