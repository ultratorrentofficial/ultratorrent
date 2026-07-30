import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import {
  selectStrategy,
  type ImportStrategy,
  type StorageCapabilities,
} from '@ultratorrent/shared';
import { placeFile, type PlacementAction } from '../../common/file-placement';
import { EngineRegistryService } from '../engine/engine-registry.service';
import { PathMappingRegistryService } from './path-mapping-registry.service';

export interface ImportRequest {
  /** Canonical source path — what arrived in staging. */
  source: string;
  /** Canonical destination path — where the renamer says it belongs. */
  destination: string;
  capabilities: StorageCapabilities;
  /** Administrator override; `auto` or absent means "decide from capabilities". */
  requested?: ImportStrategy;
  /** False only when the operator has accepted that seeding ends here. */
  requireSeeding?: boolean;
  torrentHash?: string | null;
  engineId?: string | null;
}

export interface ImportOutcome {
  /** The strategy that actually ran, which is not always the one chosen. */
  strategy: ImportStrategy;
  /** Why that strategy was chosen, for the audit trail. */
  reason: string;
  /** True when the chosen strategy proved impossible and something else ran. */
  fellBack: boolean;
  destination: string;
  /** True when the source still exists, so the torrent can keep seeding. */
  sourcePreserved: boolean;
}

/**
 * Execute one import, by whichever strategy the storage can actually support.
 *
 * The strategies are pluggable in the sense that matters: the engine asks
 * `selectStrategy` (pure, in `packages/shared`) which one to use, and dispatches
 * through a table. Adding one means adding an entry and a case — no caller
 * changes, and no part of this file knows what a torrent client is beyond the
 * provider interface.
 *
 * Two rules are load-bearing and are enforced here rather than trusted to the
 * caller:
 *
 * 1. **`move` is never inferred.** It destroys the source, so an intake that
 *    inferred it would stop a torrent seeding because a filesystem lacked a
 *    feature. It runs only when explicitly requested.
 * 2. **Provider relocation requires the provider to actually move data.**
 *    qBittorrent's `setLocation` does; rTorrent's `d.directory.set` only
 *    updates a pointer, so selecting it there would leave the client seeding
 *    from a path with nothing in it. The capability detector reports this, and
 *    the executor refuses it a second time rather than trusting the input.
 */
@Injectable()
export class ImportStrategyService {
  private readonly logger = new Logger(ImportStrategyService.name);

  constructor(
    private readonly engines: EngineRegistryService,
    private readonly paths: PathMappingRegistryService,
  ) {}

  /** What would run, without running it. Drives dry-run and the dashboard. */
  plan(req: ImportRequest): { strategy: ImportStrategy; reason: string } {
    return selectStrategy(req.capabilities, {
      override: req.requested,
      requireSeeding: req.requireSeeding ?? true,
    });
  }

  async execute(req: ImportRequest): Promise<ImportOutcome> {
    const { strategy, reason } = this.plan(req);

    // The destination directory is ours to create; the renamer produced a path,
    // not a tree. `recursive` so a first import into a new show folder works.
    await mkdir(dirname(req.destination), { recursive: true });

    if (strategy === 'provider_relocation') {
      return this.relocateViaProvider(req, reason);
    }

    const result = await placeFile(strategy as PlacementAction, req.source, req.destination);
    if (result.fellBack) {
      this.logger.log(`Import fell back to ${result.action}: ${result.reason}`);
    }
    return {
      strategy: result.action as ImportStrategy,
      // The audit has to say what happened, not what was intended.
      reason: result.fellBack ? `${reason}; ${result.reason}` : reason,
      fellBack: result.fellBack,
      destination: req.destination,
      sourcePreserved: result.action !== 'move' && result.action !== 'rename',
    };
  }

  /**
   * Ask the download client to move its own data.
   *
   * The client is told a path in ITS space, not ours — it may run in a
   * different container with a different mount, and handing it our spelling is
   * how a relocation lands somewhere nobody can find.
   *
   * A provider that cannot genuinely relocate falls through to a copy rather
   * than failing: the import still has to happen, and a copy is the safe
   * outcome that always works.
   */
  private async relocateViaProvider(req: ImportRequest, reason: string): Promise<ImportOutcome> {
    const fallback = async (why: string): Promise<ImportOutcome> => {
      this.logger.warn(`Provider relocation unavailable (${why}); copying instead.`);
      const result = await placeFile('copy', req.source, req.destination);
      return {
        strategy: result.action as ImportStrategy,
        reason: `${reason}; provider relocation unavailable: ${why}`,
        fellBack: true,
        destination: req.destination,
        sourcePreserved: true,
      };
    };

    if (!req.torrentHash || !req.engineId) return fallback('no torrent to relocate');

    let provider;
    try {
      provider = await this.engines.resolve(req.engineId);
    } catch (err) {
      return fallback((err as Error).message);
    }
    // Checked again here, not only in the detector: a stale capability row must
    // not be able to point rTorrent at an empty directory.
    if (!provider.relocationMovesData()) {
      return fallback('this engine does not move data when relocating');
    }

    const inProviderSpace = await this.paths.toSpace(
      dirname(req.destination),
      'provider',
      req.engineId,
    );
    await provider.moveStorage(req.torrentHash, inProviderSpace);
    return {
      strategy: 'provider_relocation',
      reason,
      fellBack: false,
      destination: req.destination,
      // The client moved the data and keeps seeding it from the new location.
      sourcePreserved: true,
    };
  }
}
