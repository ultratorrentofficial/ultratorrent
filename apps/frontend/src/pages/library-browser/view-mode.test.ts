import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_VIEW_MODE,
  columnsForWidth,
  isViewMode,
  readViewMode,
  rowHeightFor,
  viewModeKey,
  writeViewMode,
} from './view-mode';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('view mode preference', () => {
  it('round-trips a chosen mode', () => {
    writeViewMode('lib-1', 'table');
    expect(readViewMode('lib-1')).toBe('table');
  });

  it('keeps a preference per library', () => {
    // A music library wants a list while films want a wall.
    writeViewMode('films', 'poster');
    writeViewMode('music', 'list');
    expect(readViewMode('films')).toBe('poster');
    expect(readViewMode('music')).toBe('list');
    expect(viewModeKey('films')).not.toBe(viewModeKey('music'));
  });

  it('falls back to the default for an unknown library', () => {
    expect(readViewMode('never-seen')).toBe(DEFAULT_VIEW_MODE);
  });

  it('ignores a stored value that is no longer a valid mode', () => {
    // A mode removed in a later release must not render as a blank library.
    localStorage.setItem(viewModeKey('lib-1'), 'mosaic');
    expect(readViewMode('lib-1')).toBe(DEFAULT_VIEW_MODE);
  });

  it('survives localStorage throwing', () => {
    // Private browsing and quota-exceeded both throw. A layout preference must
    // never be the reason a library fails to render.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    expect(readViewMode('lib-1')).toBe(DEFAULT_VIEW_MODE);
    expect(() => writeViewMode('lib-1', 'grid')).not.toThrow();
  });

  it('validates modes', () => {
    expect(isViewMode('poster')).toBe(true);
    expect(isViewMode('mosaic')).toBe(false);
    expect(isViewMode(null)).toBe(false);
  });
});

describe('grid geometry', () => {
  it('gives list and table a single column whatever the width', () => {
    for (const w of [320, 1280, 3840]) {
      expect(columnsForWidth(w, 'list')).toBe(1);
      expect(columnsForWidth(w, 'table')).toBe(1);
    }
  });

  it('fits more posters as the container grows', () => {
    const narrow = columnsForWidth(400, 'poster');
    const wide = columnsForWidth(1600, 'poster');
    expect(wide).toBeGreaterThan(narrow);
  });

  it('packs compact tighter than grid, and grid tighter than poster', () => {
    const w = 1600;
    expect(columnsForWidth(w, 'compact')).toBeGreaterThan(columnsForWidth(w, 'grid'));
    expect(columnsForWidth(w, 'grid')).toBeGreaterThan(columnsForWidth(w, 'poster'));
  });

  it('never returns zero columns', () => {
    // A zero would make rowCount Infinity and the virtualizer would allocate
    // an unbounded scroll height.
    for (const w of [0, -100, 1, 50]) {
      expect(columnsForWidth(w, 'poster')).toBeGreaterThanOrEqual(1);
    }
  });

  it('sizes a poster row to a 2:3 poster plus its caption', () => {
    // 4 columns of 400px each → 600px of poster, plus caption.
    const h = rowHeightFor(1600, 4, 'poster');
    expect(h).toBeGreaterThan(600);
    expect(h).toBeLessThan(700);
  });

  it('gives list and table fixed row heights independent of width', () => {
    expect(rowHeightFor(400, 1, 'list')).toBe(rowHeightFor(3000, 1, 'list'));
    expect(rowHeightFor(400, 1, 'table')).toBe(rowHeightFor(3000, 1, 'table'));
    // A table row is shorter than a list row, which carries a thumbnail.
    expect(rowHeightFor(1600, 1, 'table')).toBeLessThan(rowHeightFor(1600, 1, 'list'));
  });

  it('scales row height with column width, so a wall stays square', () => {
    const fewColumns = rowHeightFor(1600, 2, 'poster');
    const manyColumns = rowHeightFor(1600, 8, 'poster');
    expect(fewColumns).toBeGreaterThan(manyColumns);
  });
});
