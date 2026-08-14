/**
 * Which of a torrent's files may be deleted when it ages out.
 *
 * Pure and separate from the service that does the deleting, because this is the
 * decision that can destroy a library. The rule is deliberately expressed over
 * PATHS rather than over the import strategy that produced them: a strategy is a
 * record of what was intended once, while containment is a fact about where the
 * bytes are now. `provider_relocation`, for instance, is a seeding-safe strategy
 * whose whole effect is to move the torrent's data INTO the library — trusting
 * the strategy name there would delete the library's only copy.
 *
 * Three outcomes, and the middle one is the important one:
 *
 *  - under a staging root and not under a library root → **delete**
 *  - under a library root → **keep**, unconditionally, whatever else is true
 *  - under neither → **keep**, because an unrecognised location is not evidence
 *    that a file is disposable
 *
 * A hardlinked import is safe under this rule without special handling: the
 * staging name and the library name are two directory entries for one inode, and
 * unlinking the staging one leaves the library's entry — and the bytes — intact.
 */

/** Trailing separators dropped and case folded, for comparing paths. */
function norm(p: string): string {
  return p.replace(/[/\\]+$/, '').toLowerCase();
}

/**
 * Is `file` inside `folder`? Segment-aware, so `/data/Movies2` is not inside
 * `/data/Movies` — a prefix test alone would delete out of a sibling directory
 * whose name merely starts the same way.
 */
export function isWithinRoot(file: string, folder: string): boolean {
  const f = norm(folder);
  const p = norm(file);
  if (!f || !p) return false;
  return p === f || p.startsWith(`${f}/`) || p.startsWith(`${f}\\`);
}

export interface StagingCleanupInput {
  /** Absolute paths of the torrent's files. */
  paths: string[];
  /** Intake staging/temp/failed/quarantine roots — deletable territory. */
  stagingRoots: string[];
  /** Library roots — never deletable, and they win every tie. */
  libraryRoots: string[];
}

export type CleanupKeepReason = 'in_library' | 'outside_staging';

export interface StagingCleanupPlan {
  /** Safe to unlink. */
  deletable: string[];
  /** Left alone, each with the reason it was spared. */
  kept: Array<{ path: string; reason: CleanupKeepReason }>;
}

export function planStagingCleanup(input: StagingCleanupInput): StagingCleanupPlan {
  const plan: StagingCleanupPlan = { deletable: [], kept: [] };

  for (const path of input.paths) {
    if (!path) continue;

    // Library containment is tested FIRST and is absolute. A root that is both
    // a library and a staging root (a misconfiguration, but one an operator can
    // absolutely produce) must resolve to "keep" rather than to "delete".
    if (input.libraryRoots.some((root) => isWithinRoot(path, root))) {
      plan.kept.push({ path, reason: 'in_library' });
      continue;
    }
    if (input.stagingRoots.some((root) => isWithinRoot(path, root))) {
      plan.deletable.push(path);
      continue;
    }
    plan.kept.push({ path, reason: 'outside_staging' });
  }

  return plan;
}
