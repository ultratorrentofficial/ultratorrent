/**
 * No parameterised route may capture a literal route declared after it.
 *
 * Nest matches in declaration order, so `@Get('shows/:id')` placed above
 * `@Get('shows/duplicates')` answers `/shows/duplicates` with the detail
 * handler — which returned 404 "Show not found" and silently disabled
 * duplicate SHOW detection across the platform for several releases. Nothing
 * failed loudly; the feature simply always answered "nothing found", and eight
 * split shows accumulated unnoticed.
 *
 * That class of bug is invisible in review, invisible in types, and invisible
 * in tests that exercise handlers directly rather than through routing — so it
 * is checked here, over every controller in the repo, at the level where the
 * ordering actually lives: the source.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

const SRC = path.join(__dirname, '..');

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return controllerFiles(full);
    if (!full.endsWith('.ts') || full.endsWith('.spec.ts')) return [];
    return readFileSync(full, 'utf8').includes('@Controller(') ? [full] : [];
  });
}

interface Route {
  verb: string;
  path: string;
}

/** Routes in declaration order, which is the order Nest matches them in. */
function routesOf(source: string): Route[] {
  return [...source.matchAll(/@(Get|Post|Patch|Put|Delete)\('([^']*)'\)/g)].map((m) => ({
    verb: m[1],
    path: m[2],
  }));
}

/** Does `pattern` capture the concrete `literal` path? */
export function shadows(pattern: string, literal: string): boolean {
  if (!pattern.includes(':')) return false;
  const p = pattern.split('/');
  const l = literal.split('/');
  // A different segment count cannot match; Nest has no implicit wildcard.
  if (p.length !== l.length) return false;
  return p.every((seg, i) => seg.startsWith(':') || seg === l[i]);
}

describe('route shadowing', () => {
  it('recognises the shape that broke duplicate detection', () => {
    // The regression itself, as a unit — so this test is proven to detect it.
    expect(shadows('shows/:id', 'shows/duplicates')).toBe(true);
    // A literal AFTER the parameter is not shadowed: `:type/test` cannot
    // capture `telegram/bot`, and treating it as a hit would be noise.
    expect(shadows('channels/:type/test', 'channels/telegram/bot')).toBe(false);
    expect(shadows('shows/:id', 'shows/:id/artwork')).toBe(false);
  });

  it('has controllers to check', () => {
    expect(controllerFiles(SRC).length).toBeGreaterThan(5);
  });

  it('declares every literal route above the parameterised one that would capture it', () => {
    const offenders: string[] = [];

    for (const file of controllerFiles(SRC)) {
      const routes = routesOf(readFileSync(file, 'utf8'));
      routes.forEach((route, i) => {
        for (const later of routes.slice(i + 1)) {
          if (later.verb !== route.verb || later.path.includes(':')) continue;
          if (shadows(route.path, later.path)) {
            offenders.push(
              `${path.relative(SRC, file)}: @${route.verb}('${route.path}') captures ` +
                `@${route.verb}('${later.path}') declared below it`,
            );
          }
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
