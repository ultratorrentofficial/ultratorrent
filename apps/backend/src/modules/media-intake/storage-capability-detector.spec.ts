/**
 * Capability detection — measured, never inferred.
 *
 * The values here decide whether an import is an instant hardlink or a 40 GB
 * copy, so the properties worth pinning are the conservative ones: an
 * unmeasurable probe must report `false` rather than optimism, scratch files
 * must never survive a failure, and a cross-device pair must never claim
 * hardlink support however the local probe behaved.
 */
import { StorageCapabilityDetector } from './storage-capability-detector.service';

const fsCalls = { removed: [] as string[], linked: [] as string[] };
let statBehaviour: (p: string) => { dev: number };
let linkFails = false;
let symlinkFails = false;
let writeFails = false;

jest.mock('node:fs/promises', () => ({
  stat: jest.fn(async (p: string) => statBehaviour(p)),
  mkdir: jest.fn(async () => undefined),
  writeFile: jest.fn(async () => {
    if (writeFails) throw new Error('EROFS: read-only file system');
  }),
  link: jest.fn(async (_s: string, d: string) => {
    if (linkFails) throw new Error('EXDEV');
    fsCalls.linked.push(d);
  }),
  symlink: jest.fn(async () => {
    if (symlinkFails) throw new Error('EPERM');
  }),
  rm: jest.fn(async (p: string) => { fsCalls.removed.push(p); }),
}));

let execBehaviour: (cmd: string, args: string[]) => { stdout: string };
const execCalls: Array<{ cmd: string; args: string[] }> = [];
jest.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], _o: unknown, cb: (e: Error | null, r?: unknown) => void) => {
    execCalls.push({ cmd, args });
    try {
      cb(null, execBehaviour(cmd, args));
    } catch (e) {
      cb(e as Error);
    }
  },
}));

function build(relocationMovesData = true, resolveThrows = false) {
  const probes: Record<string, unknown>[] = [];
  const prisma = {
    storageCapabilityProbe: {
      upsert: jest.fn(async (args: { create: Record<string, unknown> }) => {
        probes.push(args.create);
        return args.create;
      }),
      findUnique: jest.fn(async () => null),
    },
  };
  const engines = {
    resolve: jest.fn(async () => {
      if (resolveThrows) throw new Error('engine offline');
      return { relocationMovesData: () => relocationMovesData };
    }),
  };
  const svc = new StorageCapabilityDetector(prisma as never, engines as never);
  jest.spyOn((svc as never as { logger: { debug: (m: string) => void } }).logger, 'debug')
    .mockImplementation(() => undefined);
  return { svc, prisma, probes, engines };
}

beforeEach(() => {
  fsCalls.removed = []; fsCalls.linked = []; execCalls.length = 0;
  statBehaviour = () => ({ dev: 1 });
  linkFails = false; symlinkFails = false; writeFails = false;
  execBehaviour = (cmd, args) => {
    if (cmd === 'cp' && args.includes('--reflink=always')) return { stdout: '' };
    if (cmd === 'stat') return { stdout: 'btrfs\n' };
    return { stdout: '' };
  };
});

describe('storage capability probe', () => {
  it('detects a same-device pair that supports hardlinks', async () => {
    const { svc } = build();
    const caps = await svc.probe('p1', '/staging', '/library');
    expect(caps.sameDevice).toBe(true);
    expect(caps.hardlink).toBe(true);
  });

  it('never claims hardlink support across devices', async () => {
    /*
     * The probe writes both files under the TARGET, so it can succeed locally
     * while the real source→target pair spans a mount. Claiming it would only
     * fail later with EXDEV, after a plan had been reported.
     */
    statBehaviour = (p) => ({ dev: p === '/staging' ? 1 : 2 });
    const { svc } = build();
    const caps = await svc.probe('p1', '/staging', '/library');
    expect(caps.sameDevice).toBe(false);
    expect(caps.hardlink).toBe(false);
    expect(caps.reflink).toBe(false);
  });

  it('requires cp --reflink=always, never auto', async () => {
    /*
     * `--reflink=auto` silently falls back to a full copy, so it succeeds on
     * every filesystem on earth and would report reflink support universally —
     * turning an instant clone into a 40 GB copy with no error anywhere.
     */
    const { svc } = build();
    await svc.probe('p1', '/staging', '/library');
    const cp = execCalls.find((c) => c.cmd === 'cp');
    expect(cp).toBeDefined();
    expect(cp!.args).toContain('--reflink=always');
    expect(cp!.args.some((a) => a.includes('auto'))).toBe(false);
  });

  it('reports no reflink when cp refuses', async () => {
    execBehaviour = (cmd) => {
      if (cmd === 'cp') throw new Error('cp: failed to clone: Operation not supported');
      return { stdout: 'ext4\n' };
    };
    const { svc } = build();
    expect((await svc.probe('p1', '/staging', '/library')).reflink).toBe(false);
  });

  it('records the filesystem as diagnostic detail', async () => {
    const { svc } = build();
    expect((await svc.probe('p1', '/staging', '/library')).filesystem).toBe('btrfs');
  });

  it('reports everything false when the roots cannot be read', async () => {
    // "Could not determine" and "unsupported" lead to the same safe choice.
    statBehaviour = () => { throw new Error('ENOENT'); };
    const { svc } = build();
    const caps = await svc.probe('p1', '/nope', '/library');
    expect(caps).toMatchObject({ sameDevice: false, hardlink: false, reflink: false });
    expect(caps.error).toMatch(/Could not stat/);
  });

  it('still records a probe row when detection failed', async () => {
    // A missing row is indistinguishable from "never probed"; the operator needs
    // to see that it was tried and why it could not answer.
    statBehaviour = () => { throw new Error('ENOENT'); };
    const { svc, prisma } = build();
    await svc.probe('p1', '/nope', '/library');
    expect(prisma.storageCapabilityProbe.upsert).toHaveBeenCalled();
  });

  it('cleans up its scratch directory even when a probe throws', async () => {
    writeFails = true;
    const { svc } = build();
    const caps = await svc.probe('p1', '/staging', '/library');
    expect(caps.error).toMatch(/read-only|could not write/i);
    expect(fsCalls.removed.some((p) => p.includes('.ultratorrent-probe'))).toBe(true);
  });

  it('takes provider relocation from the engine declaration', async () => {
    const { svc } = build(true);
    expect((await svc.probe('p1', '/s', '/t', 'engine-1')).providerRelocation).toBe(true);
  });

  it('reports no relocation for an engine that only moves a pointer', async () => {
    /*
     * rTorrent's `d.directory.set` updates where rTorrent believes the data is
     * and moves nothing. Treating that as a relocation would leave it seeding
     * from an empty path.
     */
    const { svc } = build(false);
    expect((await svc.probe('p1', '/s', '/t', 'engine-1')).providerRelocation).toBe(false);
  });

  it('reports no relocation when no engine is involved', async () => {
    const { svc } = build(true);
    expect((await svc.probe('p1', '/s', '/t')).providerRelocation).toBe(false);
  });

  it('reports no relocation when the engine cannot be reached', async () => {
    // An unreachable engine is not evidence of a capability.
    const { svc } = build(true, true);
    expect((await svc.probe('p1', '/s', '/t', 'engine-1')).providerRelocation).toBe(false);
  });

  it('explains what it measured', async () => {
    // The detail line is what an operator reads when asking why it chose a copy.
    const { svc } = build();
    const caps = await svc.probe('p1', '/staging', '/library');
    expect(caps.detail).toMatch(/same device/);
    expect(caps.detail).toMatch(/hardlink/);
    expect(caps.detail).toMatch(/provider relocation/);
  });
});
