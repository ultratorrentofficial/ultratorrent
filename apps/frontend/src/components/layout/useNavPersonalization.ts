import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/auth/AuthContext';

/** How many recent pages to remember. */
export const MAX_RECENT = 8;

const keyFor = (kind: string, uid: string) => `ut.nav.${kind}.${uid}`;

function readSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}
function writeSet(key: string, s: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...s]));
  } catch {
    /* ignore persistence failures */
  }
}
function readList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function writeList(key: string, a: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(a));
  } catch {
    /* ignore persistence failures */
  }
}

export interface NavPersonalization {
  /** Nav item ids the user pinned (shown at the top of the rail). */
  pinned: Set<string>;
  /** Nav item ids the user starred (quick-access in the command palette). */
  favorites: Set<string>;
  /** Nav item ids visited recently, most-recent first (capped at {@link MAX_RECENT}). */
  recent: string[];
  togglePin: (id: string) => void;
  toggleFavorite: (id: string) => void;
  recordVisit: (id: string) => void;
  isPinned: (id: string) => boolean;
  isFavorite: (id: string) => boolean;
}

/**
 * Per-user pinned / favorites / recent, persisted to `localStorage`.
 *
 * Keyed by user id so switching accounts on a shared browser doesn't leak one user's
 * shortcuts to another. `localStorage` first (server-synced across devices is a later
 * step). Everything stores stable nav item **ids**, resolved against the live,
 * RBAC-filtered entries by the consumer — so a shortcut to a page the user can no
 * longer see simply doesn't render.
 */
export function useNavPersonalization(): NavPersonalization {
  const { user } = useAuth();
  const uid = user?.id ?? 'anon';
  const pKey = keyFor('pinned', uid);
  const fKey = keyFor('favorites', uid);
  const rKey = keyFor('recent', uid);

  const [pinned, setPinned] = useState<Set<string>>(() => readSet(pKey));
  const [favorites, setFavorites] = useState<Set<string>>(() => readSet(fKey));
  const [recent, setRecent] = useState<string[]>(() => readList(rKey));

  // Reload when the identity (and therefore the storage keys) changes.
  useEffect(() => {
    setPinned(readSet(pKey));
    setFavorites(readSet(fKey));
    setRecent(readList(rKey));
  }, [pKey, fKey, rKey]);

  const togglePin = useCallback(
    (id: string) =>
      setPinned((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        writeSet(pKey, n);
        return n;
      }),
    [pKey],
  );
  const toggleFavorite = useCallback(
    (id: string) =>
      setFavorites((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        writeSet(fKey, n);
        return n;
      }),
    [fKey],
  );
  const recordVisit = useCallback(
    (id: string) =>
      setRecent((r) => {
        if (r[0] === id) return r; // already the most recent — no churn
        const n = [id, ...r.filter((x) => x !== id)].slice(0, MAX_RECENT);
        writeList(rKey, n);
        return n;
      }),
    [rKey],
  );

  return {
    pinned,
    favorites,
    recent,
    togglePin,
    toggleFavorite,
    recordVisit,
    isPinned: (id) => pinned.has(id),
    isFavorite: (id) => favorites.has(id),
  };
}
