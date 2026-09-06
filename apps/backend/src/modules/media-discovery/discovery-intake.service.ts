import { Injectable, Logger } from '@nestjs/common';
import { access, mkdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { FilePathService } from '../files/file-path.service';
import { renderTargetPath, type PathTokens } from './discovery-path';

/**
 * Creating the staging directory an auto-monitored title will be imported into.
 *
 * Optional — a discovery template only does this when `createIntakeDirectory` is
 * set. Managed intake creates what it needs at import time anyway, so the folder
 * is a convenience: it lets an operator see, the moment a title is monitored,
 * exactly where its media will land.
 *
 * Which is why the failure behaviour matters more than the success behaviour.
 * A directory that could not be created must NOT leave a title looking healthy:
 * the reason is returned, recorded on the evaluation, and shown in the Discovery
 * Inbox. Silence here would mean a monitored title whose media has nowhere
 * obvious to go and nothing anywhere saying so.
 *
 * Three things it will not do:
 *
 *  - **Write outside the allowed storage.** `assertWithinHardRoots` is the same
 *    boundary that constrains every torrent save path, so discovery cannot reach
 *    anywhere the file manager could not.
 *  - **Replace anything.** `mkdir -p` semantics only. An existing directory is a
 *    success, not a conflict; an existing FILE at that path is a failure, because
 *    the alternative is deleting somebody's file to make room for a folder.
 *  - **Guess.** Every path comes from `renderTargetPath`, which sanitises the
 *    provider's title and asserts containment before this is reached.
 */

export interface ProvisionInput {
  /** The Storage Profile's staging root, canonical. */
  stagingRoot: string;
  pathTemplate: string;
  tokens: PathTokens;
  /** Destination library paths, so staging cannot be placed inside one. */
  libraryPaths?: string[];
}

export interface ProvisionResult {
  ok: boolean;
  /** The canonical path, present whenever rendering succeeded. */
  path?: string;
  /** `created`, `existed`, or the reason it failed. */
  detail: string;
}

@Injectable()
export class DiscoveryIntakeService {
  private readonly logger = new Logger(DiscoveryIntakeService.name);

  constructor(private readonly filePath: FilePathService) {}

  /**
   * Render the target path and make sure the directory exists.
   *
   * Idempotent: running it again for a title already provisioned reports
   * `existed` and touches nothing.
   */
  async provision(input: ProvisionInput): Promise<ProvisionResult> {
    let target: string;
    try {
      target = renderTargetPath({
        stagingRoot: input.stagingRoot,
        pathTemplate: input.pathTemplate,
        tokens: input.tokens,
        libraryPaths: input.libraryPaths,
      });
    } catch (err) {
      return { ok: false, detail: `Could not build a target path: ${(err as Error).message}` };
    }

    /*
     * The ops boundary, checked separately from the staging-root containment the
     * renderer already asserted.
     *
     * They are different questions. The renderer proves the path is under the
     * profile's staging root; this proves the staging root itself is somewhere
     * this installation is allowed to write. A profile edited to point outside
     * `FILE_MANAGER_ROOTS` would pass the first and must fail the second.
     */
    let abs: string;
    try {
      abs = this.filePath.assertWithinHardRoots(target);
    } catch (err) {
      return { ok: false, path: target, detail: (err as Error).message };
    }

    // An existing FILE where the directory should go is a failure, not something
    // to clear: removing it would be destroying data to make room for a folder.
    try {
      const existing = await stat(abs);
      if (!existing.isDirectory()) {
        return { ok: false, path: abs, detail: 'A file already exists at that path' };
      }
      const writable = await this.canWrite(abs);
      return writable
        ? { ok: true, path: abs, detail: 'existed' }
        : { ok: false, path: abs, detail: 'The directory exists but is not writable' };
    } catch {
      // Does not exist yet — the normal case.
    }

    try {
      await mkdir(abs, { recursive: true });
    } catch (err) {
      const reason = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
      this.logger.warn(`Could not create intake directory ${abs}: ${reason}`);
      return { ok: false, path: abs, detail: `Could not create the directory (${reason})` };
    }

    /*
     * Created is not the same as usable.
     *
     * A directory can be created by a process that then cannot write into it —
     * a parent with an unexpected owner, a read-only remount between the two
     * calls. Checking now means the failure surfaces while a person is looking at
     * the discovery, rather than at import time inside a sweep.
     */
    if (!(await this.canWrite(abs))) {
      return { ok: false, path: abs, detail: 'Created, but the directory is not writable' };
    }

    return { ok: true, path: abs, detail: 'created' };
  }

  private async canWrite(dir: string): Promise<boolean> {
    try {
      await access(dir, constants.W_OK | constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
}
