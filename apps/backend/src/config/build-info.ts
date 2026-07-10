import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BuildInfo {
  /** Full git commit SHA the image was built from, or null if unknown. */
  gitSha: string | null;
  /** `git describe` tag (e.g. `v0.26.0-22-g37bd0d6`), or null. */
  gitTag: string | null;
  /** ISO-8601 build timestamp, or null. */
  buildTime: string | null;
}

let cached: BuildInfo | undefined;

function pick(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/**
 * Resolve the build's git commit / describe-tag / build-time, in priority order:
 *   1. Env vars GIT_SHA / GIT_TAG / BUILD_TIME — set from the Docker build args
 *      by the canonical build (ops/scripts/docker-build.sh, npm run package).
 *   2. A baked-in build-info.json (searched up from cwd) — written by
 *      ops/scripts/stamp-build-info.js and COPYed into the image, so the commit
 *      is stamped even when the build args are NOT passed (a plain
 *      `docker compose build`). This is what makes the UI version badge ALWAYS
 *      able to show `v<version> - (<short-sha>)`.
 *   3. null.
 *
 * Cached — the values are fixed for the life of the process.
 */
export function resolveBuildInfo(): BuildInfo {
  if (cached) return cached;

  const env: BuildInfo = {
    gitSha: pick(process.env.GIT_SHA),
    gitTag: pick(process.env.GIT_TAG),
    buildTime: pick(process.env.BUILD_TIME),
  };

  let file: BuildInfo = { gitSha: null, gitTag: null, buildTime: null };
  for (const rel of [
    'build-info.json',
    '../build-info.json',
    '../../build-info.json',
    '../../../build-info.json',
  ]) {
    try {
      const raw = JSON.parse(readFileSync(join(process.cwd(), rel), 'utf8'));
      file = {
        gitSha: pick(raw.gitSha),
        gitTag: pick(raw.gitTag),
        buildTime: pick(raw.buildTime),
      };
      break;
    } catch {
      /* try next candidate path */
    }
  }

  cached = {
    gitSha: env.gitSha ?? file.gitSha,
    gitTag: env.gitTag ?? file.gitTag,
    buildTime: env.buildTime ?? file.buildTime,
  };
  return cached;
}

/** Test-only: clear the memoized value so a test can re-resolve. */
export function resetBuildInfoCache(): void {
  cached = undefined;
}
