import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Tailwind 3's spacing scale only defines half-steps up to 3.5 — 0.5, 1.5, 2.5,
 * 3.5. Anything past that (`h-4.5`, `w-6.5`, `p-5.5`) is not a class at all: it
 * typechecks, passes review, ships, and emits NO CSS, so the element silently
 * loses that dimension.
 *
 * Two were live simultaneously when this was written: a server icon meant to be
 * 20px, and a KPI tile icon that had no size at all and had gone unnoticed
 * because the surrounding flexbox made it look deliberate.
 */

const SRC = join(__dirname, '..');
const HALF_STEP =
  /\b(?:[hw]|p[trblxy]?|m[trblxy]?|gap(?:-[xy])?|space-[xy]|inset|top|left|right|bottom|size)-(\d+)\.5\b/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

describe('Tailwind spacing classes actually exist', () => {
  it('uses no half-step above 3.5', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      for (const m of readFileSync(file, 'utf8').matchAll(HALF_STEP)) {
        if (Number(m[1]) >= 4) offenders.push(`${file.replace(SRC, 'src')}: ${m[0]}`);
      }
    }
    expect(offenders, 'these emit no CSS at all').toEqual([]);
  });

  it('still allows the half-steps Tailwind does define', () => {
    const sample = 'h-3.5 w-2.5 p-1.5 gap-0.5';
    const flagged = [...sample.matchAll(HALF_STEP)].filter((m) => Number(m[1]) >= 4);
    expect(flagged).toEqual([]);
  });
});
