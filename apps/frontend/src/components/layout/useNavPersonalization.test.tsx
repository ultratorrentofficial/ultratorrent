import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { MAX_RECENT, useNavPersonalization } from './useNavPersonalization';

const auth = vi.hoisted(() => ({ user: { id: 'u1' } as { id: string } | null }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => auth }));

describe('useNavPersonalization', () => {
  beforeEach(() => {
    localStorage.clear();
    auth.user = { id: 'u1' };
  });

  it('pins and unpins, persisting to localStorage', () => {
    const { result } = renderHook(() => useNavPersonalization());
    expect(result.current.isPinned('media-duplicates')).toBe(false);
    act(() => result.current.togglePin('media-duplicates'));
    expect(result.current.isPinned('media-duplicates')).toBe(true);
    expect(JSON.parse(localStorage.getItem('ut.nav.pinned.u1')!)).toContain('media-duplicates');
    act(() => result.current.togglePin('media-duplicates'));
    expect(result.current.isPinned('media-duplicates')).toBe(false);
  });

  it('favorites independently of pins', () => {
    const { result } = renderHook(() => useNavPersonalization());
    act(() => result.current.toggleFavorite('rss'));
    expect(result.current.isFavorite('rss')).toBe(true);
    expect(result.current.isPinned('rss')).toBe(false);
  });

  it('records recent most-recent-first, de-duped and capped', () => {
    const { result } = renderHook(() => useNavPersonalization());
    act(() => result.current.recordVisit('a'));
    act(() => result.current.recordVisit('b'));
    act(() => result.current.recordVisit('a')); // revisit moves it to the front
    expect(result.current.recent).toEqual(['a', 'b']);

    act(() => {
      for (let i = 0; i < MAX_RECENT + 5; i += 1) result.current.recordVisit(`p${i}`);
    });
    expect(result.current.recent).toHaveLength(MAX_RECENT);
    expect(result.current.recent[0]).toBe(`p${MAX_RECENT + 4}`);
  });

  it('is scoped per user — a different account does not see the first user’s shortcuts', () => {
    const first = renderHook(() => useNavPersonalization());
    act(() => first.result.current.togglePin('media-duplicates'));

    auth.user = { id: 'u2' };
    const second = renderHook(() => useNavPersonalization());
    expect(second.result.current.isPinned('media-duplicates')).toBe(false);
    expect(localStorage.getItem('ut.nav.pinned.u2')).toBeNull();
  });

  it('does not churn recent when revisiting the current page', () => {
    const { result } = renderHook(() => useNavPersonalization());
    act(() => result.current.recordVisit('a'));
    const before = result.current.recent;
    act(() => result.current.recordVisit('a'));
    expect(result.current.recent).toBe(before); // same array reference — no re-render churn
  });
});
