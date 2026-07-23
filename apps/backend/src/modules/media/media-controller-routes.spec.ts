import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { MediaController } from './media.controller';

/**
 * A pure guard on route DECLARATION ORDER.
 *
 * Nest registers routes in the order their handlers are declared, and Express
 * matches the first that fits. So a literal path declared AFTER a parameter path
 * that could capture it never runs. That is exactly what silently broke the
 * Duplicate Center's bulk endpoints: `POST duplicates/bulk/preview` sat after
 * `POST duplicates/:groupId/preview`, so every "Quick Clean" request was captured
 * with `groupId="bulk"` and rejected. This test locks the ordering so it cannot
 * regress without a failing build rather than a silently dead endpoint.
 */

interface Route { name: string; method: number; path: string; index: number }

function routesOf(controller: new (...args: never[]) => object): Route[] {
  const proto = controller.prototype as Record<string, unknown>;
  // Own property order preserves declaration order for string keys.
  return Object.getOwnPropertyNames(proto)
    .filter((n) => n !== 'constructor' && typeof proto[n] === 'function')
    .map((name, index) => {
      const handler = proto[name] as object;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      return path != null && method != null ? { name, method, path, index } : null;
    })
    .filter((r): r is Route => r !== null);
}

/** Segments after the `duplicates/` prefix; null for non-duplicate routes. */
function dupSegments(path: string): string[] | null {
  if (path !== 'duplicates' && !path.startsWith('duplicates/')) return null;
  return path.split('/').slice(1); // drop the leading "duplicates"
}

describe('MediaController duplicate route ordering', () => {
  const routes = routesOf(MediaController);
  const dupRoutes = routes.filter((r) => dupSegments(r.path) !== null);

  it('declares every literal duplicate route before any :groupId route that could capture it', () => {
    // The offender is a single-parameter route like `duplicates/:groupId/<x>` (or
    // bare `duplicates/:groupId`): its first segment is a wildcard, so it captures a
    // literal `duplicates/<word>/<x>` of the same method + arity declared later.
    const paramRoutes = dupRoutes.filter((r) => {
      const seg = dupSegments(r.path)!;
      return seg[0]?.startsWith(':');
    });

    for (const literal of dupRoutes) {
      const seg = dupSegments(literal.path)!;
      if (seg.length === 0 || seg[0].startsWith(':')) continue; // not a first-segment literal
      for (const param of paramRoutes) {
        const pseg = dupSegments(param.path)!;
        const sameMethod = param.method === literal.method;
        const sameArity = pseg.length === seg.length;
        if (sameMethod && sameArity && param.index < literal.index) {
          throw new Error(
            `Route "${literal.method === RequestMethod.GET ? 'GET' : 'POST'} duplicates/${seg.join('/')}" ` +
              `(#${literal.index}) is shadowed by parameter route "duplicates/${pseg.join('/')}" (#${param.index}) ` +
              `declared before it — it will never match.`,
          );
        }
      }
    }
  });

  it('keeps the previously-broken bulk + quick-clean routes reachable', () => {
    const byPath = (p: string) => dupRoutes.find((r) => r.path === p);
    const bulkPreview = byPath('duplicates/bulk/preview');
    const groupPreview = byPath('duplicates/:groupId/preview');
    expect(bulkPreview).toBeDefined();
    expect(groupPreview).toBeDefined();
    // The exact regression: bulk/preview must precede :groupId/preview.
    expect(bulkPreview!.index).toBeLessThan(groupPreview!.index);

    // And the other literals used by Quick Clean stay ahead of the bare :groupId GET.
    const groupGet = byPath('duplicates/:groupId');
    for (const p of ['duplicates/quick-clean/candidates', 'duplicates/trash/history']) {
      expect(byPath(p)!.index).toBeLessThan(groupGet!.index);
    }
  });
});
