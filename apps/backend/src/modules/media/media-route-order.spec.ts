/**
 * A `:id` route must never be declared above a literal one that shares its
 * prefix.
 *
 * Nest matches in declaration order. `@Get('shows/:id')` was added above
 * `@Get('shows/duplicates')` and answered it with 404 "Show not found" — which
 * silently disabled duplicate SHOW detection everywhere, including the scan
 * that reports families and the Duplicate Center, until a live library turned
 * out to be holding two folders for one series with nothing flagging it.
 *
 * The invariant is about SOURCE ORDER, so the source is what this reads.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const source = readFileSync(path.join(__dirname, 'media.controller.ts'), 'utf8');

/** Where a route decorator appears in the file, or -1. */
const at = (decorator: string) => source.indexOf(decorator);

describe('media controller route order', () => {
  const parameterised = at("@Get('shows/:id')");

  it('declares the show detail route at all', () => {
    expect(parameterised).toBeGreaterThan(-1);
  });

  it.each([
    "@Get('shows/duplicates')",
    "@Get('shows/by-key')",
  ])('declares %s before the :id route', (literal) => {
    const literalAt = at(literal);
    expect(literalAt).toBeGreaterThan(-1);
    expect(literalAt).toBeLessThan(parameterised);
  });

  it('keeps every literal shows/… GET above the parameterised one', () => {
    // Written as a sweep rather than a list so a route added later is covered
    // without anyone remembering to extend this test.
    const literals = [...source.matchAll(/@Get\('shows\/([a-z][\w-]*)'\)/g)];
    expect(literals.length).toBeGreaterThan(0);
    for (const m of literals) {
      expect(m.index).toBeLessThan(parameterised);
    }
  });
});
