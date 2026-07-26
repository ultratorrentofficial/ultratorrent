import { describe, expect, it } from 'vitest';
import {
  EMPTY_SELECTION,
  applyClick,
  clearSelection,
  pruneSelection,
  selectAllLoaded,
  selectOne,
  selectRange,
  toggleChecked,
  toggleOne,
} from './selection';

const ORDER = ['a', 'b', 'c', 'd', 'e'];
const ids = (s: { ids: ReadonlySet<string> }) => [...s.ids].sort();

describe('selection', () => {
  it('replaces the selection on a plain click', () => {
    const s = selectOne('c');
    expect(ids(s)).toEqual(['c']);
    expect(s.anchor).toBe('c');
  });

  it('toggles one row on ctrl/cmd click, leaving the rest', () => {
    let s = selectOne('a');
    s = toggleOne(s, 'c');
    expect(ids(s)).toEqual(['a', 'c']);
    s = toggleOne(s, 'a');
    expect(ids(s)).toEqual(['c']);
  });

  it('moves the anchor even when ctrl-clicking DESELECTS', () => {
    // Every file manager ranges from the row you last touched, not from the
    // last one that happened to remain selected.
    let s = selectOne('a');
    s = toggleOne(s, 'd');
    s = toggleOne(s, 'd');
    expect(ids(s)).toEqual(['a']);
    expect(s.anchor).toBe('d');
  });

  it('selects an inclusive range on shift click', () => {
    let s = selectOne('b');
    s = selectRange(s, 'd', ORDER);
    expect(ids(s)).toEqual(['b', 'c', 'd']);
  });

  it('ranges backwards just as well', () => {
    let s = selectOne('d');
    s = selectRange(s, 'b', ORDER);
    expect(ids(s)).toEqual(['b', 'c', 'd']);
  });

  it('keeps the anchor fixed so a range can be grown and shrunk', () => {
    let s = selectOne('b');
    s = selectRange(s, 'e', ORDER);
    expect(ids(s)).toEqual(['b', 'c', 'd', 'e']);
    // Shift-clicking nearer the anchor must not start a new range from 'e'.
    s = selectRange(s, 'c', ORDER);
    expect(s.anchor).toBe('b');
  });

  it('degrades to a plain click when shift is pressed with no anchor', () => {
    // A dead first click is worse than a reasonable guess.
    const s = selectRange(EMPTY_SELECTION, 'c', ORDER);
    expect(ids(s)).toEqual(['c']);
    expect(s.anchor).toBe('c');
  });

  it('does not select everything when the anchor has been filtered away', () => {
    // indexOf returning -1 would otherwise range from the start of the list.
    const stale = { ids: new Set(['zz']), anchor: 'zz' };
    const s = selectRange(stale, 'c', ORDER);
    expect(ids(s)).toEqual(['c']);
  });

  it('lets a checkbox toggle without disturbing the anchor', () => {
    let s = selectOne('b');
    s = toggleChecked(s, 'e');
    expect(ids(s)).toEqual(['b', 'e']);
    expect(s.anchor).toBe('b');
  });

  it('select-all covers the loaded rows only', () => {
    // Paging is incremental: claiming 500,000 while holding 60 would make every
    // count and every subsequent action a lie.
    const s = selectAllLoaded(ORDER);
    expect(ids(s)).toEqual([...ORDER].sort());
    expect(s.ids.size).toBe(ORDER.length);
  });

  it('clears to empty', () => {
    expect(clearSelection().ids.size).toBe(0);
    expect(clearSelection().anchor).toBeNull();
  });

  describe('pruning when the list changes', () => {
    it('drops rows that are gone', () => {
      const s = pruneSelection({ ids: new Set(['a', 'zz']), anchor: 'a' }, ORDER);
      expect(ids(s)).toEqual(['a']);
    });

    it('clears an anchor that no longer exists', () => {
      const s = pruneSelection({ ids: new Set(['a']), anchor: 'zz' }, ORDER);
      expect(s.anchor).toBeNull();
    });

    it('keeps the same reference when nothing changed', () => {
      // Identity matters: this runs on every list change, and a new object each
      // time would re-render the whole grid.
      const before = { ids: new Set(['a', 'b']), anchor: 'a' };
      expect(pruneSelection(before, ORDER)).toBe(before);
    });

    it('never leaves a selection acting on invisible rows', () => {
      const filtered = ['a', 'b'];
      const s = pruneSelection({ ids: new Set(ORDER), anchor: 'e' }, filtered);
      expect(ids(s)).toEqual(['a', 'b']);
      expect(s.anchor).toBeNull();
    });
  });

  describe('modifier resolution', () => {
    it('routes shift to a range and meta to a toggle', () => {
      const base = selectOne('b');
      expect(ids(applyClick(base, 'd', ORDER, { shift: true }))).toEqual(['b', 'c', 'd']);
      expect(ids(applyClick(base, 'd', ORDER, { meta: true }))).toEqual(['b', 'd']);
      expect(ids(applyClick(base, 'd', ORDER, {}))).toEqual(['d']);
    });

    it('prefers shift when both modifiers are held', () => {
      const base = selectOne('b');
      const s = applyClick(base, 'd', ORDER, { shift: true, meta: true });
      expect(ids(s)).toEqual(['b', 'c', 'd']);
    });
  });
});
