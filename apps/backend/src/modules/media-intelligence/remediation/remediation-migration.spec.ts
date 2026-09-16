import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TERMINAL_PLAN_STATUSES } from '@ultratorrent/shared';

/**
 * The one place SQL and TypeScript can silently disagree.
 *
 * "One active plan per recommendation" is enforced by a PARTIAL unique index,
 * because terminal plans are history: a succeeded plan from last week must not
 * block a new one today. Postgres cannot import `TERMINAL_PLAN_STATUSES`, so
 * the migration repeats the list — and a repetition nobody checks is a
 * repetition that drifts.
 *
 * If the two fall out of step the failure is invisible and bad in both
 * directions: add a terminal status to TypeScript only, and its plans keep
 * blocking new ones forever; remove one from the SQL only, and the same drift
 * spawns unlimited plans. Hence this test rather than a comment.
 */

const MIGRATION = join(
  __dirname,
  '../../../../prisma/migrations/20260916030000_media_remediation_plans/migration.sql',
);

function migrationSql(): string {
  return readFileSync(MIGRATION, 'utf8');
}

describe('the active-plan partial index', () => {
  it('excludes exactly the statuses TypeScript calls terminal', () => {
    const sql = migrationSql();
    const match = sql.match(/"status"\s+NOT\s+IN\s+\(([^)]*)\)/i);
    expect(match).toBeTruthy();

    const inSql = (match![1].match(/'([a-z_]+)'/g) ?? [])
      .map((s) => s.replace(/'/g, ''))
      .sort();
    const inTs = [...TERMINAL_PLAN_STATUSES].sort();

    expect(inSql).toEqual(inTs);
  });

  it('constrains only rows that name a recommendation', () => {
    // A plan with no recommendation (a policy-initiated one) must not collide
    // with every other such plan on a single NULL key.
    expect(migrationSql()).toMatch(/"recommendationId"\s+IS\s+NOT\s+NULL/i);
  });

  it('keeps a plan alive after the finding that justified it is deleted', () => {
    /*
     * A plan records what UltraTorrent actually did. Cascading it away with
     * its finding would delete the answer to "why did this happen" at exactly
     * the moment someone asks.
     */
    const sql = migrationSql();
    expect(sql).toMatch(/media_remediation_plans_findingId_fkey[\s\S]*?ON DELETE SET NULL/i);
    expect(sql).toMatch(/media_remediation_plans_recommendationId_fkey[\s\S]*?ON DELETE SET NULL/i);
  });

  it('removes steps and history with their plan, which have no meaning alone', () => {
    const sql = migrationSql();
    expect(sql).toMatch(/media_remediation_steps_planId_fkey[\s\S]*?ON DELETE CASCADE/i);
    expect(sql).toMatch(/media_remediation_plan_events_planId_fkey[\s\S]*?ON DELETE CASCADE/i);
  });

  it('is additive — it alters and drops nothing that already existed', () => {
    const sql = migrationSql();
    // The only ALTER TABLEs may be the four FK additions on the new tables.
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT)\b/i);
    expect(sql).not.toMatch(/ALTER\s+TABLE\s+"(?!media_remediation)/i);
  });
});
