/**
 * Detects transitions in a repeatedly-observed boolean.
 *
 * Several producers poll: the torrent sync loop sees the same error state every
 * two seconds, the provider health check every minute, the disk watcher every
 * few minutes. Each needs to publish **once, when the state changes** — not on
 * every observation.
 *
 * Shared rather than reimplemented per module, because the subtle part is the
 * same everywhere and getting it slightly different in three places is how one
 * of them ends up notifying hourly. The bus's dedupe window is a safety net for
 * this; edge detection is the actual mechanism, and the two are complementary —
 * the window bounds the damage if a detector is reset by a restart.
 */
export class EdgeDetector {
  /** key → last observed state. Absent means never observed. */
  private readonly state = new Map<string, boolean>();

  /**
   * Record an observation and report what changed.
   *
   * - `rising`  — became true (a torrent errored, a provider went offline)
   * - `falling` — became false (it recovered)
   * - `null`    — unchanged, or the very first observation
   *
   * **The first observation never reports an edge.** On startup every torrent
   * already in an error state would otherwise fire at once, which is a flood of
   * notifications about things that failed while nobody was watching — and
   * indistinguishable, to the person reading them, from things failing now.
   */
  observe(key: string, active: boolean): 'rising' | 'falling' | null {
    const previous = this.state.get(key);
    this.state.set(key, active);
    if (previous === undefined) return null;
    if (previous === active) return null;
    return active ? 'rising' : 'falling';
  }

  /**
   * Forget a key.
   *
   * Called when the thing itself is gone — a removed torrent, a deleted
   * connection — so the map does not grow forever, and so a later reappearance
   * is treated as new rather than compared against a stale state.
   */
  forget(key: string): void {
    this.state.delete(key);
  }

  /** Drop every key not in the supplied set. Keeps the map bounded to reality. */
  retainOnly(keys: Iterable<string>): void {
    const keep = new Set(keys);
    for (const key of this.state.keys()) {
      if (!keep.has(key)) this.state.delete(key);
    }
  }

  /** Current known state, for tests and diagnostics. */
  peek(key: string): boolean | undefined {
    return this.state.get(key);
  }

  get size(): number {
    return this.state.size;
  }
}
