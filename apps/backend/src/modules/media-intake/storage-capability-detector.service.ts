import { execFile } from 'node:child_process';
import { link, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Injectable, Logger } from '@nestjs/common';
import type { StorageCapabilities } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { EngineRegistryService } from '../engine/engine-registry.service';

const run = promisify(execFile);

/** Where probe scratch files live, so a failed probe leaves nothing behind. */
const PROBE_DIR = '.ultratorrent-probe';

/**
 * Find out what the storage can actually do — by doing it.
 *
 * Every value here is measured rather than inferred. A path string cannot tell
 * you whether two directories share a device, whether the filesystem supports
 * copy-on-write, or whether the mount is a network share pretending otherwise;
 * guessing is how an import silently becomes a 40 GB copy on a NAS, or fails at
 * execution time having already reported a plan.
 *
 * The probes are deliberately tiny (an empty file), always cleaned up, and
 * never fatal: a probe that cannot run records `false` with the reason, because
 * "we could not determine this" and "this is unsupported" lead to the same safe
 * choice — a copy.
 */
@Injectable()
export class StorageCapabilityDetector {
  private readonly logger = new Logger(StorageCapabilityDetector.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly engines: EngineRegistryService,
  ) {}

  /**
   * Probe one source→target pair and persist the result.
   *
   * `engineId` decides `providerRelocation`, which is **declared by the provider
   * rather than probed**: establishing it empirically would mean relocating a
   * real torrent to see what happened. qBittorrent moves the payload;
   * rTorrent's `d.directory.set` only updates a pointer, so it is not a
   * relocation at all and must never be selected as one.
   */
  async probe(
    profileId: string,
    sourceRoot: string,
    targetRoot: string,
    engineId?: string | null,
  ): Promise<StorageCapabilities & { detail: string; error: string | null }> {
    const detail: string[] = [];
    let error: string | null = null;

    let sameDevice = false;
    let filesystem: string | null = null;
    try {
      const [a, b] = await Promise.all([stat(sourceRoot), stat(targetRoot)]);
      sameDevice = a.dev === b.dev;
      detail.push(sameDevice ? 'same device' : `different devices (${a.dev} vs ${b.dev})`);
    } catch (err) {
      error = `Could not stat both roots: ${(err as Error).message}`;
      // Nothing else can be trusted if the roots are not both readable, so stop
      // here rather than emit a row of falses that looks like a real measurement.
      const caps = { sameDevice: false, hardlink: false, reflink: false, symlink: false,
        providerRelocation: false, filesystem: null };
      await this.persist(profileId, sourceRoot, targetRoot, caps, detail.join('; '), error);
      return { ...caps, detail: detail.join('; '), error };
    }

    const scratch = join(targetRoot, PROBE_DIR);
    const src = join(scratch, 'source');
    let hardlink = false;
    let reflink = false;
    let symlinkOk = false;

    try {
      await mkdir(scratch, { recursive: true });
      await writeFile(src, '');

      hardlink = await this.tryLink(src, join(scratch, 'hard'));
      detail.push(`hardlink ${hardlink ? 'ok' : 'unavailable'}`);

      reflink = await this.tryReflink(src, join(scratch, 'reflink'));
      detail.push(`reflink ${reflink ? 'ok' : 'unavailable'}`);

      symlinkOk = await this.trySymlink(src, join(scratch, 'sym'));
      detail.push(`symlink ${symlinkOk ? 'ok' : 'unavailable'}`);

      filesystem = await this.filesystemOf(targetRoot);
    } catch (err) {
      error = `Probe could not write to the target: ${(err as Error).message}`;
    } finally {
      // Always, including on failure: a probe that litters is a probe nobody
      // will run twice.
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }

    const providerRelocation = await this.providerCanRelocate(engineId);
    detail.push(`provider relocation ${providerRelocation ? 'supported' : 'unsupported'}`);

    const caps: StorageCapabilities = {
      sameDevice,
      // A hardlink across devices cannot work whatever the probe said, and the
      // probe writes both files under the TARGET, so it never tests that.
      hardlink: hardlink && sameDevice,
      reflink: reflink && sameDevice,
      symlink: symlinkOk,
      providerRelocation,
      filesystem,
    };
    const detailText = detail.join('; ');
    await this.persist(profileId, sourceRoot, targetRoot, caps, detailText, error);
    return { ...caps, detail: detailText, error };
  }

  /** The most recent probe for a pair, or null if it has never been measured. */
  async latest(profileId: string, sourceRoot: string, targetRoot: string) {
    return this.prisma.storageCapabilityProbe.findUnique({
      where: { profileId_sourceRoot_targetRoot: { profileId, sourceRoot, targetRoot } },
    });
  }

  private async tryLink(src: string, dest: string): Promise<boolean> {
    try {
      await link(src, dest);
      await rm(dest, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  private async trySymlink(src: string, dest: string): Promise<boolean> {
    try {
      await symlink(src, dest);
      await rm(dest, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reflink support, via `cp --reflink=always`.
   *
   * Node's `fs` exposes no `FICLONE` ioctl, so the only way to establish this
   * without a native binding is to ask `cp` to do it and see whether it
   * refuses. `always` is essential — the default `auto` silently falls back to
   * a full copy and would report success on every filesystem on earth.
   */
  private async tryReflink(src: string, dest: string): Promise<boolean> {
    try {
      await run('cp', ['--reflink=always', src, dest], { timeout: 5000 });
      await rm(dest, { force: true });
      return true;
    } catch {
      await rm(dest, { force: true }).catch(() => undefined);
      return false;
    }
  }

  /** Best-effort filesystem name. Diagnostic only — never gates a decision. */
  private async filesystemOf(path: string): Promise<string | null> {
    try {
      const { stdout } = await run('stat', ['-f', '-c', '%T', path], { timeout: 5000 });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Ask the engine whether its relocation moves data.
   *
   * Declared by the provider, not probed. Unknown or unreachable engines answer
   * `false`, so the strategy selector falls through to a copy rather than
   * assuming a capability it could not confirm.
   */
  private async providerCanRelocate(engineId?: string | null): Promise<boolean> {
    if (!engineId) return false;
    try {
      const provider = await this.engines.resolve(engineId);
      return provider.relocationMovesData();
    } catch (err) {
      this.logger.debug(`Could not resolve engine ${engineId}: ${(err as Error).message}`);
      return false;
    }
  }

  private async persist(
    profileId: string,
    sourceRoot: string,
    targetRoot: string,
    caps: StorageCapabilities,
    detail: string,
    error: string | null,
  ): Promise<void> {
    const data = {
      sameDevice: caps.sameDevice,
      hardlink: caps.hardlink,
      reflink: caps.reflink,
      symlink: caps.symlink,
      providerRelocation: caps.providerRelocation,
      filesystem: caps.filesystem ?? null,
      detail,
      error,
      detectedAt: new Date(),
    };
    await this.prisma.storageCapabilityProbe.upsert({
      where: { profileId_sourceRoot_targetRoot: { profileId, sourceRoot, targetRoot } },
      create: { profileId, sourceRoot, targetRoot, ...data },
      update: data,
    });
  }
}
