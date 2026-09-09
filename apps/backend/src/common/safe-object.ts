/**
 * Copying key/value pairs out of an object whose KEYS came from outside.
 *
 * Provider configuration, engine settings and subtitle settings all arrive as
 * open-ended maps: the caller sends `{ apiKey: '…', baseUrl: '…' }` and the
 * server copies the pairs into a fresh object before storing them. The values
 * are validated; the key names are whatever was sent.
 *
 * `__proto__` is the one that matters. `JSON.parse` gives it to you as a real
 * own property, so it survives into `Object.entries`, and assigning it to a
 * plain object literal does not store an entry — it invokes the inherited
 * setter and REPLACES that object's prototype. The copy then silently drops the
 * key while inheriting whatever the attacker's object carried, and a later
 * lookup can resolve to something nobody stored.
 *
 * `Object.create(null)` fixes it at the object, and is the right answer where
 * the map stays internal — the bencode parser uses exactly that. It is the wrong
 * answer here, because these objects are handed to Prisma as JSON columns,
 * spread into other objects and passed to code that may reasonably call a method
 * on them. Dropping the key is the smaller, more predictable change.
 *
 * Nothing legitimate is lost. No engine, media server or subtitle provider has a
 * setting named `__proto__`, `constructor` or `prototype`, and a request that
 * sends one is not configuring anything.
 */

/** Keys that must never be copied from caller-supplied data onto an object. */
export const UNSAFE_OBJECT_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

export function isUnsafeObjectKey(key: string): boolean {
  return UNSAFE_OBJECT_KEYS.includes(key);
}

/**
 * `Object.entries`, minus the keys that would poison the target object.
 *
 * A drop-in at a copy loop: `for (const [k, v] of safeEntries(input))`.
 */
export function safeEntries<T = unknown>(input: unknown): Array<[string, T]> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  return Object.entries(input as Record<string, T>).filter(([k]) => !isUnsafeObjectKey(k));
}
