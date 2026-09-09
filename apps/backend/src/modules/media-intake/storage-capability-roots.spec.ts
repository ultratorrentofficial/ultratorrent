import { StorageCapabilityDetector } from './storage-capability-detector.service';

/**
 * The probe creates a scratch directory and then removes it **recursively**, so
 * where it runs must never be in doubt.
 *
 * These are storage-profile paths — administrative configuration rather than
 * request input — which is why this is a shape check and not a containment
 * gate. The specific hazard is `join('', '.ultratorrent-probe')`: that yields a
 * RELATIVE path, and a relative path resolves against the process working
 * directory, so a blank root would have created and then recursively deleted a
 * directory inside the application's own tree. Nothing downstream would have
 * caught it, because the operation would have succeeded.
 */
function build() {
  const persisted: Array<Record<string, unknown>> = [];
  const prisma = {
    storageCapabilityProbe: { upsert: async (a: Record<string, unknown>) => { persisted.push(a); return {}; } },
  };
  const detector = new StorageCapabilityDetector(prisma as never, { get: () => null } as never);
  return { detector, persisted };
}

describe('a probe refuses a root it cannot locate', () => {
  it.each([
    ['an empty target root', '/srv/media', ''],
    ['a blank target root', '/srv/media', '   '],
    ['an empty source root', '', '/srv/media'],
    ['a relative target root', '/srv/media', 'relative/path'],
    ['a relative source root', 'relative/path', '/srv/media'],
    ['a bare directory name', '/srv/media', 'media'],
  ])('refuses %s', async (_label, source, target) => {
    const { detector } = build();
    const out = await detector.probe('p1', source, target);
    expect(out.error).toBeTruthy();
    // Every capability reports false: "could not determine" and "unsupported"
    // both lead to the same safe choice, which is a copy.
    expect(out.sameDevice).toBe(false);
    expect(out.hardlink).toBe(false);
    expect(out.reflink).toBe(false);
    expect(out.symlink).toBe(false);
  });

  it('says which root is wrong, so the profile can be corrected', async () => {
    const { detector } = build();
    const out = await detector.probe('p1', '/srv/media', 'relative/path');
    expect(out.error).toMatch(/absolute/i);
  });

  it('names the working-directory hazard for an empty root', async () => {
    const { detector } = build();
    const out = await detector.probe('p1', '/srv/media', '');
    expect(out.error).toMatch(/working directory/i);
  });

  it('records the refusal rather than failing silently', async () => {
    const { detector, persisted } = build();
    await detector.probe('p1', '/srv/media', '');
    expect(persisted).toHaveLength(1);
  });

  /*
   * The legitimate case must still reach the filesystem. Two absolute paths are
   * accepted here and fail later on stat, which is the probe doing its job —
   * measuring rather than inferring — not the guard rejecting them.
   */
  it('accepts two absolute roots and proceeds to measure them', async () => {
    const { detector } = build();
    const out = await detector.probe('p1', '/nonexistent-source', '/nonexistent-target');
    expect(out.error).toMatch(/stat both roots/i);
    expect(out.error).not.toMatch(/absolute|working directory/i);
  });
});
