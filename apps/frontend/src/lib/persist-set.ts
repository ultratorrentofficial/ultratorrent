/**
 * Tiny helpers for persisting a Set<string> of ids in localStorage — used for
 * sidebar group-collapse and sub-menu-expand state. Failures (private mode,
 * quota) degrade gracefully to in-memory behavior.
 */
export function readStringSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? (parsed as string[]) : []);
  } catch {
    return new Set();
  }
}

export function writeStringSet(key: string, set: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch {
    /* ignore persistence failures */
  }
}

/** Return a new Set with `id` toggled, persisting it under `key`. */
export function toggleInSet(key: string, set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  writeStringSet(key, next);
  return next;
}
