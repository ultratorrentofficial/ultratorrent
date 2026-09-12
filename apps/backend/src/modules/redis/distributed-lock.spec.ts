import { DistributedLockService } from './distributed-lock.service';

/**
 * The lock's contract holds whether or not Redis is present: `withLock` runs the
 * function under an exclusive lease and a second attempt on the same key while it
 * is held is refused. Pointing at an unreachable port forces the in-process
 * fallback so the test is deterministic in CI (no Redis).
 */
const svc = () => new DistributedLockService({ get: (k: string) => (k === 'redis.host' ? '127.0.0.1' : 1) } as never);

describe('DistributedLockService', () => {
  it('runs the function and returns its result', async () => {
    const r = await svc().withLock('k1', 1000, async () => 42);
    expect(r).toEqual({ ran: true, result: 42 });
  });

  it('refuses a re-entrant acquire of the same key while held', async () => {
    const lock = svc();
    let inner: { ran: boolean } | undefined;
    await lock.withLock('k2', 1000, async () => {
      inner = await lock.withLock('k2', 1000, async () => 'should not run');
    });
    expect(inner).toEqual({ ran: false });
  });

  it('releases the key so a later acquire succeeds', async () => {
    const lock = svc();
    await lock.withLock('k3', 1000, async () => 'first');
    const second = await lock.withLock('k3', 1000, async () => 'second');
    expect(second).toEqual({ ran: true, result: 'second' });
  });

  it('lets different keys proceed independently', async () => {
    const lock = svc();
    let bRan = false;
    await lock.withLock('a', 1000, async () => {
      const b = await lock.withLock('b', 1000, async () => { bRan = true; return 1; });
      expect(b.ran).toBe(true);
    });
    expect(bRan).toBe(true);
  });
});
