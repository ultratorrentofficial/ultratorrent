import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * No component may format a date without going through `format.ts`.
 *
 * Raw `toLocaleDateString()` / `toLocaleString()` / `new Intl.DateTimeFormat`
 * silently follow the BROWSER's zone, ignoring the one the user chose in their
 * profile. That is not a hypothetical: the per-user timezone feature shipped
 * with the helpers made zone-aware and **13 call sites still bypassing them**,
 * including the notification inbox — the very surface the feature was requested
 * for. It was reported by a user, not caught by a gate.
 *
 * A convention nobody can check is a convention that decays, so this checks it.
 * Adding a zone-aware helper to `format.ts` is the way to satisfy it; reaching
 * past it is not.
 */

const SRC = join(__dirname, '..');

/** Files allowed to construct formatters directly, with the reason. */
const ALLOWED = new Map<string, string>([
  ['lib/format.ts', 'defines the helpers'],
  ['lib/format-usage.test.ts', 'this guard'],
  ['components/playback/playback-tokens.ts', 'passes the active zone explicitly'],
  ['pages/account/TimezoneSection.tsx', 'previews a zone the user has not saved yet'],
]);

/** Date formatting that ignores the display zone. Number `toLocaleString()`
 *  is fine and deliberately not matched — only date-bearing calls are. */
const OFFENDERS = [
  /new\s+Date\([^)]*\)\s*\.toLocaleString\s*\(/,
  /new\s+Date\([^)]*\)\s*\.toLocaleDateString\s*\(/,
  /new\s+Date\([^)]*\)\s*\.toLocaleTimeString\s*\(/,
  /\.toLocaleDateString\s*\(\s*\)/,
  /\.toLocaleTimeString\s*\(\s*\)/,
  /new\s+Intl\.DateTimeFormat\s*\(/,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('every displayed date goes through format.ts', () => {
  it('finds no raw date formatting outside the allowed files', () => {
    const violations: string[] = [];

    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length + 1).replace(/\\/g, '/');
      if (ALLOWED.has(rel)) continue;

      const source = readFileSync(file, 'utf8');
      source.split('\n').forEach((line, i) => {
        if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return;
        if (OFFENDERS.some((re) => re.test(line))) {
          violations.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`);
        }
      });
    }

    // Printed in full so a failure names every site rather than just a count.
    expect(violations).toEqual([]);
  });

  it('keeps the allow-list honest', () => {
    // An entry that no longer exists means the list is drifting from reality
    // and the next reader will trust something stale.
    for (const rel of ALLOWED.keys()) {
      expect(() => statSync(join(SRC, rel))).not.toThrow();
    }
  });
});
