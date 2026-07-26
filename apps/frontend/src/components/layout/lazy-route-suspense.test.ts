import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A lazy() route with no <Suspense> ancestor does not render a fallback — React
 * throws (#426) and the navigation fails outright, because a sidebar click is a
 * discrete update and React refuses to suspend one without a boundary.
 *
 * This shipped in 0.48.0: three notification pages were lazy() with no boundary
 * anywhere above <Routes>. Nothing caught it — `tsc` sees valid JSX, and the
 * component tests never mount a real router, so the break only appears on a real
 * click in a real browser.
 *
 * Hence a structural check. It asserts the invariant (every lazy page renders
 * inside a boundary), not the formatting.
 */
const SRC = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

describe('lazy routes always have a Suspense boundary', () => {
  it('AppShell wraps its Outlet in Suspense', () => {
    // Every routed page renders through this one Outlet, so guarding it covers
    // all of them — including lazy routes added later, which is the point.
    const shell = read('components/layout/AppShell.tsx');
    const outlet = shell.indexOf('<Outlet />');
    expect(outlet).toBeGreaterThan(-1);

    const before = shell.slice(0, outlet);
    const openBoundaries =
      (before.match(/<Suspense[\s>]/g) ?? []).length - (before.match(/<\/Suspense>/g) ?? []).length;
    expect(openBoundaries).toBeGreaterThan(0);
  });

  it('every lazy() page in App.tsx renders under a boundary', () => {
    const app = read('App.tsx');
    const lazyNames = [...app.matchAll(/^const (\w+) = lazy\(/gm)].map((m) => m[1]);
    expect(lazyNames.length).toBeGreaterThan(0);

    // A lazy component is safe if it carries its own inline <Suspense>, or if it
    // is routed inside AppShell — whose Outlet is guarded by the test above.
    const unguarded = lazyNames.filter((name) => {
      const routed = new RegExp(`element=\\{<${name}\\s*/>\\}`).test(app);
      if (!routed) return false; // rendered some other way; not a route element
      const inline = new RegExp(`<Suspense[^>]*>\\s*<${name}\\s*/>`).test(app);
      return !inline;
    });

    // Guarded by the AppShell outlet — assert they are actually routed through it
    // rather than assuming, since a route outside AppShell would have no boundary.
    const outsideShell = unguarded.filter((name) => {
      const idx = app.indexOf(`<${name} />`);
      const enclosing = app.lastIndexOf('<Route element={<AppShell />}>', idx);
      const closed = app.lastIndexOf('</Route>', idx);
      return enclosing === -1 || closed > enclosing;
    });

    expect(outsideShell).toEqual([]);
  });
});
