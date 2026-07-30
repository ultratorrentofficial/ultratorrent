/**
 * The intake state machine, strategy selection and path registry.
 *
 * These are the rules every other part of the engine will be built on, so they
 * are pinned before anything depends on them. All pure — no filesystem, no
 * database, no provider.
 */
import {
  canTransition,
  nextState,
  isActiveIntake,
  selectStrategy,
  preservesSource,
  toSpace,
  fromSpace,
  isUnderPrefix,
  INTAKE_STATES,
  TERMINAL_INTAKE_STATES,
  SEEDING_SAFE_STRATEGIES,
  type IntakeState,
  type PathMappingRule,
  type StorageCapabilities,
} from '@ultratorrent/shared';

describe('intake lifecycle', () => {
  it('walks the happy path end to end', () => {
    /*
     * The order splits on WHAT EACH STAGE OPERATES ON. Everything up to
     * `imported` works on a path in staging; everything after works on a
     * MediaItem — which cannot exist until a library scan has found the file,
     * because every enrichment entry point in this codebase takes an item id.
     * Quality scoring sits before the import decision deliberately: the score is
     * what decides upgrade versus replace, so it has to be known first.
     */
    const path: IntakeState[] = [
      'queued', 'downloading', 'completed',
      'verified', 'identified', 'quality_scored', 'ready_to_import',
      'importing', 'imported',
      'metadata_ready', 'artwork_ready', 'subtitle_ready',
      'seeding', 'archived',
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('enriches only after the item exists', () => {
    // The constraint behind the ordering: enrichment cannot precede the import
    // that creates the item, so these edges must not exist.
    expect(canTransition('identified', 'metadata_ready')).toBe(false);
    expect(canTransition('verified', 'artwork_ready')).toBe(false);
    expect(canTransition('imported', 'metadata_ready')).toBe(true);
  });

  it('refuses to skip a stage', () => {
    // Importing something that was never identified is the failure this guards.
    expect(canTransition('completed', 'ready_to_import')).toBe(false);
    expect(canTransition('verified', 'imported')).toBe(false);
    expect(canTransition('identified', 'importing')).toBe(false);
  });

  it('lets any live state fail or be cancelled', () => {
    for (const s of INTAKE_STATES) {
      if (TERMINAL_INTAKE_STATES.includes(s)) continue;
      expect(canTransition(s, 'failed')).toBe(true);
      expect(canTransition(s, 'cancelled')).toBe(true);
    }
  });

  it('never moves out of a settled terminal state', () => {
    // archived and cancelled are the end; failed and quarantined are recoverable
    // by explicit operator action, which is why they are excluded here.
    for (const s of ['archived', 'cancelled'] as IntakeState[]) {
      for (const to of INTAKE_STATES) expect(canTransition(s, to)).toBe(false);
    }
  });

  it('lets a failure retry back into the pipeline', () => {
    expect(canTransition('failed', 'identified')).toBe(true);
    expect(canTransition('failed', 'archived')).toBe(false);
  });

  it('only quarantines from stages that can form that opinion', () => {
    /*
     * Quarantine means "a human must look at this". Verification and
     * identification can conclude that; artwork retrieval cannot, and letting it
     * claim so would put items in front of an operator for no stated reason.
     */
    expect(canTransition('completed', 'quarantined')).toBe(true);
    expect(canTransition('verified', 'quarantined')).toBe(true);
    expect(canTransition('artwork_ready', 'quarantined')).toBe(false);
  });

  it('resumes a released quarantine into the pipeline, never straight to import', () => {
    expect(canTransition('quarantined', 'verified')).toBe(true);
    expect(canTransition('quarantined', 'ready_to_import')).toBe(false);
  });

  it('treats a state as its own non-transition', () => {
    // Re-applying the current state must not count as progress, or a stuck
    // pipeline looks like a moving one.
    for (const s of INTAKE_STATES) expect(canTransition(s, s)).toBe(false);
  });

  it('does not count seeding as active work', () => {
    // Seeding is indefinite and healthy; showing it under "in progress" would
    // make the queue permanently non-empty.
    expect(isActiveIntake('seeding')).toBe(false);
    expect(isActiveIntake('importing')).toBe(true);
    expect(isActiveIntake('archived')).toBe(false);
  });

  it('advances to the documented next stage', () => {
    expect(nextState('verified')).toBe('identified');
    expect(nextState('archived')).toBeNull();
  });

  it('starts a queued intake at completed, not downloading', () => {
    /*
     * Intake never downloads anything — the torrent client does, and the
     * trigger only fires once it finished, so the payload is already on disk.
     * When this returned `downloading` every intake stalled at step one waiting
     * for a stage that cannot exist. Found by running a real file through it,
     * not by a test: every test supplied the state it wanted to start from.
     */
    expect(nextState('queued')).toBe('completed');
    // Still a legal edge for a future source that streams in while tracked.
    expect(canTransition('queued', 'downloading')).toBe(true);
  });
});

describe('strategy selection', () => {
  const caps = (over: Partial<StorageCapabilities> = {}): StorageCapabilities => ({
    sameDevice: false, hardlink: false, reflink: false, symlink: false,
    providerRelocation: false, ...over,
  });

  it('prefers a hardlink when the storage allows one', () => {
    expect(selectStrategy(caps({ sameDevice: true, hardlink: true })).strategy).toBe('hardlink');
  });

  it('prefers a reflink over a copy on copy-on-write storage', () => {
    expect(selectStrategy(caps({ sameDevice: true, reflink: true })).strategy).toBe('reflink');
  });

  it('will not hardlink across devices even when the filesystem supports links', () => {
    // The EXDEV case. Selecting it here would only fail at execution time.
    expect(selectStrategy(caps({ sameDevice: false, hardlink: true })).strategy).not.toBe('hardlink');
  });

  it('uses provider relocation when nothing local works', () => {
    expect(selectStrategy(caps({ providerRelocation: true })).strategy).toBe('provider_relocation');
  });

  it('falls back to copy rather than failing', () => {
    expect(selectStrategy(caps()).strategy).toBe('copy');
  });

  it('NEVER auto-selects move', () => {
    /*
     * The load-bearing rule. `move` destroys the source, so an engine that
     * inferred it would stop a torrent seeding because a filesystem lacked a
     * feature — something the operator never asked for.
     */
    for (const c of [caps(), caps({ sameDevice: true, hardlink: true }), caps({ providerRelocation: true })]) {
      expect(selectStrategy(c).strategy).not.toBe('move');
    }
  });

  it('honours an explicit move, and says it was forced', () => {
    const out = selectStrategy(caps(), { override: 'move' });
    expect(out.strategy).toBe('move');
    expect(out.reason).toMatch(/override/);
  });

  it('honours an override even when detection disagrees', () => {
    // Detection can be wrong about an exotic mount; the override exists for it.
    expect(selectStrategy(caps({ hardlink: false }), { override: 'hardlink' }).strategy).toBe('hardlink');
  });

  it('treats auto as "decide for me", not as a strategy', () => {
    expect(selectStrategy(caps({ sameDevice: true, hardlink: true }), { override: 'auto' }).strategy)
      .toBe('hardlink');
  });

  it('only offers seeding-safe strategies when seeding must continue', () => {
    for (const s of SEEDING_SAFE_STRATEGIES) expect(preservesSource(s)).toBe(true);
    expect(preservesSource('move')).toBe(false);
  });

  it('gives a reason with every choice', () => {
    // The audit trail has to answer "why did it copy 40GB", not just "it copied".
    expect(selectStrategy(caps({ sameDevice: true, hardlink: true })).reason).toBeTruthy();
    expect(selectStrategy(caps()).reason).toBeTruthy();
  });
});

describe('path mapping registry', () => {
  const rule = (over: Partial<PathMappingRule> = {}): PathMappingRule => ({
    id: 'r1', space: 'container', fromPrefix: '/media', toPrefix: '/downloads',
    scopeId: null, priority: 0, enabled: true, ...over,
  });

  it('rewrites a canonical path into a space', () => {
    expect(toSpace('/media/Movies/x.mkv', 'container', [rule()])).toBe('/downloads/Movies/x.mkv');
  });

  it('round-trips back to canonical', () => {
    const rules = [rule()];
    const there = toSpace('/media/Movies/x.mkv', 'container', rules);
    expect(fromSpace(there, 'container', rules)).toBe('/media/Movies/x.mkv');
  });

  it('leaves an unmapped path alone', () => {
    // The single-host case, which must need no configuration at all.
    expect(toSpace('/other/x.mkv', 'container', [rule()])).toBe('/other/x.mkv');
  });

  it('does not treat a sibling directory as a child', () => {
    /*
     * `/media-backup` is NOT under `/media`. A plain startsWith would rewrite it
     * into an unrelated tree — and an import that lands in the wrong tree is
     * indistinguishable from data loss.
     */
    expect(isUnderPrefix('/media-backup/x', '/media')).toBe(false);
    expect(toSpace('/media-backup/x.mkv', 'container', [rule()])).toBe('/media-backup/x.mkv');
  });

  it('matches a directory against itself', () => {
    expect(isUnderPrefix('/media', '/media')).toBe(true);
  });

  it('prefers the more specific prefix', () => {
    const rules = [rule(), rule({ id: 'r2', fromPrefix: '/media/tv', toPrefix: '/tv' })];
    expect(toSpace('/media/tv/show.mkv', 'container', rules)).toBe('/tv/show.mkv');
  });

  it('prefers a scoped rule over a global one', () => {
    const rules = [rule(), rule({ id: 'r2', toPrefix: '/qbit-data', scopeId: 'engine-1' })];
    expect(toSpace('/media/x.mkv', 'container', rules, 'engine-1')).toBe('/qbit-data/x.mkv');
    // A different engine falls back to the global rule.
    expect(toSpace('/media/x.mkv', 'container', rules, 'engine-2')).toBe('/downloads/x.mkv');
  });

  it('ignores rules for another space', () => {
    expect(toSpace('/media/x.mkv', 'media_server', [rule({ space: 'container' })])).toBe('/media/x.mkv');
  });

  it('ignores a disabled rule', () => {
    expect(toSpace('/media/x.mkv', 'container', [rule({ enabled: false })])).toBe('/media/x.mkv');
  });

  it('tolerates trailing and doubled separators', () => {
    const rules = [rule({ fromPrefix: '/media/', toPrefix: '/downloads/' })];
    expect(toSpace('/media//Movies/x.mkv', 'container', rules)).toBe('/downloads/Movies/x.mkv');
  });

  it('is a no-op for the canonical space', () => {
    expect(toSpace('/media/x.mkv', 'canonical', [rule()])).toBe('/media/x.mkv');
  });
});
