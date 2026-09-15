import { MEDIA_FINDING_CODES, type MediaIntelligenceEntityType, type UnifiedMediaState } from '@ultratorrent/shared';

import { evaluateMediaHealth, boundedSample, type EvaluationInput } from './media-health-evaluator';

/**
 * The deterministic core, tested as a pure function.
 *
 * Most of these cases are not "does the rule fire" but "does the rule REFUSE to
 * fire" — Phase 1's hardest requirement is that it must not invent problems.
 * Unmeasured data, an unwatched film, a 1080p file and a torrent that stopped
 * seeding are all normal, and a layer that calls them defects trains operators
 * to ignore it.
 */

const NOW = new Date('2026-09-15T12:00:00.000Z');

type Facts = EvaluationInput['facts'];

/** A section that could be read and had nothing wrong with it. */
const known = (source: string) => ({ status: 'known' as const, source, observedAt: NOW.toISOString() });
const unknown = (source: string, reason: string) => ({
  status: 'unknown' as const,
  source,
  observedAt: null,
  unknownReason: reason as never,
});

/** A fully healthy movie. Individual tests override one section at a time. */
function facts(over: Partial<Facts> = {}): Facts {
  const base: Facts = {
    entityType: 'movie',
    entityId: 'item-1',
    identity: {
      ...known('media_manager'),
      title: 'Alien',
      normalizedTitle: 'alien',
      year: 1979,
      seasonNumber: null,
      episodeNumber: null,
      episodeTitle: null,
      externalIds: { imdb: 'tt0078748' },
      matchStatus: 'matched',
      confidence: 1,
      conflictingExternalIds: false,
    },
    library: {
      ...known('media_manager'),
      present: true,
      libraryId: 'lib-1',
      libraryName: 'Movies',
      libraryKind: 'movie',
      path: '/media/Movies/Alien (1979)',
      fileCount: 1,
      episodeCount: null,
      seasonCount: null,
      totalBytes: 68_000_000_000,
      duplicateGroupCount: 0,
      duplicateReclaimableBytes: 0,
      lastScanAt: NOW.toISOString(),
    },
    completeness: {
      ...known('media_acquisition'),
      expected: null,
      owned: null,
      missing: null,
      unaired: null,
      ignored: null,
      excludedFromScope: null,
      completionPercent: null,
      showStatus: null,
    },
    quality: {
      owned: {
        provenance: 'measured', resolutionClass: '1080p', resolutionOrdinal: 4,
        width: 1920, height: 1080, videoCodec: 'x265', videoBitDepth: 8,
        hdr: false, hdrFormat: null, audioCodec: 'e-ac-3', audioChannels: 6,
        bitrateKbps: 4200, frameRate: 23.976, durationSec: 7000, container: 'mkv',
        sizeBytes: 900_000_000,
      },
      ladder: { source: 'global_ladder', sourceLabel: 'Global', rungs: [] },
      compliance: {
        status: 'preferred', matchedRung: 0, matchedRungName: 'top', preferredRung: 0,
        totalRungs: 2, upgradePotential: false, dimensions: [], reasons: [],
        unknownReason: null, preferenceSource: 'global_ladder', preferenceSourceLabel: 'Global',
      },
      aggregate: null, measuredFileCount: 1, totalFileCount: 1,
    },
    technical: {
      ...known('media_manager'),
      measuredFileCount: 1,
      unprobedFileCount: 0,
      unmeasurableFileCount: 0,
      profile: {
        width: 3840, height: 2160, resolution: '2160p', videoCodec: 'hevc', bitrateKbps: 15000,
        durationSec: 6960, frameRate: 23.976, videoBitDepth: 10, hdrFormat: 'HDR10',
        audioCodec: 'eac3', audioChannels: 6, container: 'mkv', sizeBytes: 68_000_000_000,
      },
      distinctProfileCount: 1,
      declared: null,
    },
    metadata: {
      ...known('media_manager'),
      provider: 'tmdb', hasOverview: true, hasGenres: true, year: 1979,
      runtimeMinutes: 116, nfoPresent: true, updatedAt: NOW.toISOString(),
    },
    artwork: {
      ...known('media_manager'),
      posterPresent: true, fanartPresent: true, typesPresent: ['poster', 'fanart'], missingRequiredCount: 0,
    },
    subtitles: {
      ...known('media_manager'),
      languages: ['en', 'es'], itemsWithSubtitles: 1, itemsTotal: 1, embeddedTracksKnown: false,
    },
    acquisition: {
      ...unknown('media_acquisition', 'not_monitored'),
      monitored: false, watchlistItemId: null, mode: null, watchlistStatus: null,
      ruleId: null, ruleEnabled: null, usesGlobalPreferences: null,
      searchesPending: null, searchesFailed: null, searchesNoResults: null,
      lastSearchAt: null, lastGrabAt: null, activeBackfillJobId: null,
    },
    intake: {
      ...known('media_intake'),
      total: 1, active: 0, imported: 1, failed: 0, quarantined: 0,
      lastIntakeAt: NOW.toISOString(), lastError: null,
    },
    torrent: {
      ...known('torrents'),
      associatedCount: 1, seedingCount: 1, erroredCount: 0, linkedItemCount: 1, consideredItemCount: 1,
    },
    usage: {
      ...known('media_server_analytics'),
      playCount: 3, completedPlayCount: 2, uniqueViewerCount: 1,
      lastPlayedAt: '2026-08-25T00:00:00.000Z', totalPlaybackSeconds: 14000, approximate: false,
    },
    storage: {
      ...known('media_manager'),
      totalBytes: 68_000_000_000, fileCount: 1, duplicateBytes: 0, reclaimableBytes: 0,
      storageProfileId: null, storageProfileName: null,
    },
  } as unknown as Facts;

  return { ...base, ...over } as Facts;
}

function evaluate(over: Partial<Facts> = {}, entityType: MediaIntelligenceEntityType = 'movie') {
  const f = facts(over);
  const input: EvaluationInput = { entityType, entityId: 'item-1', facts: { ...f, entityType } as Facts, now: NOW };
  return evaluateMediaHealth(input);
}

const codes = (r: ReturnType<typeof evaluate>) => r.findings.map((f) => f.code);

describe('evaluateMediaHealth — healthy baselines', () => {
  it('1. a complete movie is HEALTHY with no findings', () => {
    const r = evaluate();
    expect(r.findings).toHaveLength(0);
    expect(r.health.status).toBe('healthy');
    expect(r.health.reasons).toHaveLength(0);
  });

  it('2. a complete series raises no missing-episode finding', () => {
    const r = evaluate(
      { completeness: { ...facts().completeness, expected: 62, owned: 62, missing: 0, unaired: 0, ignored: 0, completionPercent: 100 } } as Partial<Facts>,
      'series',
    );
    expect(codes(r)).not.toContain(MEDIA_FINDING_CODES.EPISODES_MISSING);
    expect(r.health.status).toBe('healthy');
  });
});

describe('evaluateMediaHealth — real defects', () => {
  it('3. missing aired episodes raise a bounded COMPLETENESS finding and ATTENTION', () => {
    const r = evaluate(
      { completeness: { ...facts().completeness, expected: 62, owned: 59, missing: 3, unaired: 0, ignored: 0, completionPercent: 95 } } as Partial<Facts>,
      'series',
    );
    const f = r.findings.find((x) => x.code === MEDIA_FINDING_CODES.EPISODES_MISSING);
    expect(f).toBeDefined();
    expect(f!.domain).toBe('completeness');
    expect(f!.evidence).toMatchObject({ missing: 3, expected: 62 });
    expect(r.health.status).toBe('attention');
    expect(r.health.reasons).toContain(MEDIA_FINDING_CODES.EPISODES_MISSING);
  });

  it('4. unaired episodes are NOT reported as missing', () => {
    const r = evaluate(
      { completeness: { ...facts().completeness, expected: 10, owned: 8, missing: 0, unaired: 2, ignored: 0 } } as Partial<Facts>,
      'series',
    );
    expect(codes(r)).not.toContain(MEDIA_FINDING_CODES.EPISODES_MISSING);
    expect(r.health.status).toBe('healthy');
  });

  it('5. ignored episodes are NOT reported as missing', () => {
    const r = evaluate(
      { completeness: { ...facts().completeness, expected: 10, owned: 9, missing: 0, unaired: 0, ignored: 1 } } as Partial<Facts>,
      'series',
    );
    expect(codes(r)).not.toContain(MEDIA_FINDING_CODES.EPISODES_MISSING);
  });

  it('6. a failed intake is an ERROR and degrades health', () => {
    const r = evaluate({ intake: { ...facts().intake, failed: 1, lastError: 'checksum mismatch' } } as Partial<Facts>);
    const f = r.findings.find((x) => x.code === MEDIA_FINDING_CODES.INTAKE_FAILED);
    expect(f?.severity).toBe('error');
    expect(r.health.status).toBe('degraded');
  });

  it('7. an unresolved identity is reported only when there is no id at all', () => {
    const r = evaluate({
      identity: { ...facts().identity, matchStatus: 'unmatched', confidence: 0, externalIds: {} },
    } as Partial<Facts>);
    expect(codes(r)).toContain(MEDIA_FINDING_CODES.IDENTITY_UNRESOLVED);
    expect(r.health.status).toBe('attention');
  });

  it('8. duplicates raise a storage finding with bounded evidence', () => {
    const r = evaluate({
      library: { ...facts().library, duplicateGroupCount: 2, duplicateReclaimableBytes: 5_000_000 },
    } as Partial<Facts>);
    const f = r.findings.find((x) => x.code === MEDIA_FINDING_CODES.DUPLICATE_MEDIA_PRESENT);
    expect(f?.domain).toBe('storage');
    expect(f!.evidence).toMatchObject({ groups: 2 });
    expect(JSON.stringify(f!.evidence).length).toBeLessThan(500);
  });
});

describe('evaluateMediaHealth — UNKNOWN is not a failure and not a zero', () => {
  it('9. no technical probe yields an informational finding, not a defect', () => {
    const r = evaluate({
      technical: { ...facts().technical, measuredFileCount: 0, unprobedFileCount: 4, profile: null, distinctProfileCount: null },
    } as Partial<Facts>);
    const f = r.findings.find((x) => x.code === MEDIA_FINDING_CODES.MEDIA_TECHNICAL_DATA_MISSING);
    expect(f?.severity).toBe('info');
    // Informational findings must never move overall health.
    expect(r.health.status).toBe('healthy');
  });

  it('11. an unmappable usage section leaves health healthy and the domain unknown', () => {
    const r = evaluate({
      usage: { ...unknown('media_server_analytics', 'no_mapping'), playCount: null, completedPlayCount: null, uniqueViewerCount: null, lastPlayedAt: null, totalPlaybackSeconds: null, approximate: true },
    } as unknown as Partial<Facts>);
    expect(r.health.status).toBe('healthy');
    expect(r.health.domains.find((d) => d.domain === 'usage')?.status).toBe('unknown');
  });

  it('12. a known mapping with zero plays is KNOWN, not unknown', () => {
    const r = evaluate({
      usage: { ...known('media_server_analytics'), playCount: 0, completedPlayCount: 0, uniqueViewerCount: 0, lastPlayedAt: null, totalPlaybackSeconds: 0, approximate: false },
    } as unknown as Partial<Facts>);
    expect(r.health.domains.find((d) => d.domain === 'usage')?.status).toBe('healthy');
  });

  it('13. an unknown torrent association is not an error', () => {
    const r = evaluate({
      torrent: { ...unknown('torrents', 'no_torrent_link'), associatedCount: null, seedingCount: null, erroredCount: null, linkedItemCount: null, consideredItemCount: null },
    } as unknown as Partial<Facts>);
    expect(codes(r)).not.toContain(MEDIA_FINDING_CODES.TORRENT_ERROR);
    expect(r.health.status).toBe('healthy');
  });

  it('blind on identity AND library yields UNKNOWN overall, not healthy', () => {
    const r = evaluate({
      identity: { ...unknown('media_manager', 'no_mapping'), externalIds: {}, matchStatus: null, confidence: null, conflictingExternalIds: false, title: null, normalizedTitle: null, year: null, seasonNumber: null, episodeNumber: null, episodeTitle: null },
      library: { ...unknown('media_manager', 'not_scanned'), present: null, libraryId: null, libraryName: null, libraryKind: null, path: null, fileCount: null, episodeCount: null, seasonCount: null, totalBytes: null, duplicateGroupCount: null, duplicateReclaimableBytes: null, lastScanAt: null },
    } as unknown as Partial<Facts>);
    expect(r.health.status).toBe('unknown');
  });
});

describe('evaluateMediaHealth — preference is not failure', () => {
  it('10/14/15/16. no subtitles, not seeding, old media and 1080p are never unhealthy', () => {
    const r = evaluate({
      // No sidecar subtitle rows at all — embedded tracks are not modelled, so
      // this must not become a coverage claim.
      subtitles: { ...facts().subtitles, languages: [], itemsWithSubtitles: 0, itemsTotal: 1 },
      torrent: { ...facts().torrent, seedingCount: 0, erroredCount: 0 },
      usage: { ...facts().usage, lastPlayedAt: '2024-01-01T00:00:00.000Z' },
      technical: {
        ...facts().technical,
        profile: { ...facts().technical.profile!, width: 1920, height: 1080, resolution: '1080p', videoCodec: 'h264', hdrFormat: null },
      },
    } as Partial<Facts>);
    expect(r.health.status).toBe('healthy');
    expect(r.findings).toHaveLength(0);
  });

  it('a partial subtitle gap is reported, but only as information', () => {
    const r = evaluate(
      { subtitles: { ...facts().subtitles, itemsWithSubtitles: 58, itemsTotal: 62 } } as Partial<Facts>,
      'series',
    );
    const f = r.findings.find((x) => x.code === MEDIA_FINDING_CODES.SUBTITLE_COVERAGE_INCOMPLETE);
    expect(f?.severity).toBe('info');
    expect(f!.evidence).toMatchObject({ withSubtitles: 58, total: 62, without: 4 });
    expect(r.health.status).toBe('healthy');
  });
});

describe('evaluateMediaHealth — aggregation and determinism', () => {
  it('severity-aware: one error outranks several warnings', () => {
    const r = evaluate({
      completeness: { ...facts().completeness, expected: 10, owned: 7, missing: 3 },
      library: { ...facts().library, duplicateGroupCount: 1, duplicateReclaimableBytes: 1 },
      intake: { ...facts().intake, failed: 1 },
    } as Partial<Facts>);
    expect(r.health.status).toBe('degraded');
    // Worst-first ordering, so a UI never has to sort.
    expect(r.findings[0].severity).toBe('error');
  });

  it('24. identical facts evaluate identically (idempotent)', () => {
    const a = evaluate({ completeness: { ...facts().completeness, missing: 2, expected: 10, owned: 8 } } as Partial<Facts>, 'series');
    const b = evaluate({ completeness: { ...facts().completeness, missing: 2, expected: 10, owned: 8 } } as Partial<Facts>, 'series');
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('25. a resolved source fact removes the finding', () => {
    const before = evaluate({ completeness: { ...facts().completeness, missing: 1, expected: 10, owned: 9 } } as Partial<Facts>, 'series');
    const after = evaluate({ completeness: { ...facts().completeness, missing: 0, expected: 10, owned: 10 } } as Partial<Facts>, 'series');
    expect(codes(before)).toContain(MEDIA_FINDING_CODES.EPISODES_MISSING);
    expect(codes(after)).not.toContain(MEDIA_FINDING_CODES.EPISODES_MISSING);
    expect(after.health.status).toBe('healthy');
  });

  it('26. a resolved intake failure clears the error', () => {
    const after = evaluate({ intake: { ...facts().intake, failed: 0 } } as Partial<Facts>);
    expect(codes(after)).not.toContain(MEDIA_FINDING_CODES.INTAKE_FAILED);
  });

  it('27. an external-id conflict is reported, never silently merged', () => {
    const r = evaluate({
      identity: { ...facts().identity, conflictingExternalIds: true, externalIds: { imdb: 'tt0078748' } },
    } as Partial<Facts>);
    const f = r.findings.find((x) => x.code === MEDIA_FINDING_CODES.IDENTITY_EXTERNAL_ID_CONFLICT);
    expect(f?.severity).toBe('error');
  });

  it('18. a movie needs no TV-only fields to evaluate', () => {
    const r = evaluate();
    expect(r.health.status).toBe('healthy');
    expect(r.health.domains.find((d) => d.domain === 'completeness')?.status).not.toBe('critical');
  });

  it('28. evidence stays bounded for a very large series', () => {
    const many = Array.from({ length: 900 }, (_, i) => `S01E${i + 1}`);
    const { sample, omitted } = boundedSample(many);
    expect(sample).toHaveLength(10);
    expect(omitted).toBe(890);
  });

  it('every finding carries a domain, severity and entity ref for the Attention Center', () => {
    const r = evaluate({ intake: { ...facts().intake, failed: 2 } } as Partial<Facts>);
    for (const f of r.findings) {
      expect(f.domain).toBeTruthy();
      expect(f.severity).toBeTruthy();
      expect(f.entityId).toBe('item-1');
      expect(f.entityType).toBe('movie');
      // Codes are machine identities — never localized prose.
      expect(f.code).toMatch(/^[A-Z_]+$/);
    }
  });
});

describe('quality compliance', () => {
  /** The healthy fixture with only the compliance verdict swapped out. */
  const withCompliance = (over: Record<string, unknown>): Partial<Facts> => {
    const base = facts().quality as unknown as Record<string, unknown>;
    return {
      quality: { ...base, compliance: { ...(base.compliance as object), ...over } },
    } as unknown as Partial<Facts>;
  };

  it('says nothing when the preferred rung is matched', () => {
    const { findings } = evaluate();
    expect(findings.map((f) => f.code)).not.toContain(MEDIA_FINDING_CODES.QUALITY_UPGRADE_POTENTIAL);
  });

  it('says nothing when no acquisition preferences exist', () => {
    // Absence of a policy is not a verdict; inventing one would assert a
    // preference the operator never expressed.
    const { findings, health } = evaluate(
      withCompliance({ status: 'unknown', unknownReason: 'no_acquisition_preferences', matchedRung: null }),
    );
    expect(findings.filter((f) => f.code.startsWith('QUALITY_'))).toHaveLength(0);
    expect(health.status).toBe('healthy');
  });

  it('opens an OPPORTUNITY for a fallback rung, which never degrades health', () => {
    const { findings, health } = evaluate(
      withCompliance({ status: 'acceptable', matchedRung: 2, matchedRungName: '1080p x264', upgradePotential: true }),
    );
    const f = findings.find((x) => x.code === MEDIA_FINDING_CODES.QUALITY_UPGRADE_POTENTIAL);
    expect(f?.severity).toBe('opportunity');
    // A playable file the operator's own ladder accepts is not a problem.
    expect(health.status).toBe('healthy');
    expect(f?.evidence).toMatchObject({ matchedRung: 2, upgradeAvailable: false });
  });

  it('opens a WARNING when the file satisfies no configured rung', () => {
    const { findings, health } = evaluate(
      withCompliance({ status: 'below_preference', matchedRung: null, upgradePotential: false }),
    );
    const f = findings.find((x) => x.code === MEDIA_FINDING_CODES.QUALITY_BELOW_PREFERENCE);
    expect(f?.severity).toBe('warning');
    expect(health.status).toBe('attention');
  });

  it('never claims an upgrade is AVAILABLE, only that potential exists', () => {
    const { findings } = evaluate(
      withCompliance({ status: 'acceptable', matchedRung: 1, upgradePotential: true }),
    );
    const f = findings.find((x) => x.code === MEDIA_FINDING_CODES.QUALITY_UPGRADE_POTENTIAL);
    expect(f?.evidence.upgradeAvailable).toBe(false);
    // No capability is pointed at: CAMA registers no acquisition search.
    expect(f?.actionable).toBe(false);
  });

  it('bounds the evidence it attaches', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      dimension: 'terms' as const, result: 'fail' as const, required: `t${i}`, actual: null, reason: null,
    }));
    const { findings } = evaluate(withCompliance({ status: 'below_preference', dimensions: many }));
    const f = findings.find((x) => x.code === MEDIA_FINDING_CODES.QUALITY_BELOW_PREFERENCE);
    expect((f?.evidence.blockedBy as unknown[]).length).toBeLessThanOrEqual(5);
    expect(f?.evidence.omitted).toBe(15);
  });
});
