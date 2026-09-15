import {
  HEALTH_AFFECTING_SEVERITIES,
  MEDIA_FINDING_CODES,
  MEDIA_FINDING_DEFINITIONS,
  MEDIA_INTELLIGENCE_DOMAINS,
  type MediaDomainHealth,
  type MediaFinding,
  type MediaFindingCodeValue,
  type MediaFindingSeverity,
  type MediaHealthStatus,
  type MediaHealthSummary,
  type MediaIntelligenceDomain,
  type MediaIntelligenceEntityType,
  type MediaQualityFacts,
  type UnifiedMediaState,
} from '@ultratorrent/shared';

/**
 * The deterministic core of Media Intelligence.
 *
 * Everything here is a pure function of already-assembled facts: no Prisma, no
 * HTTP, no clock beyond what the caller passes in. That is deliberate — health
 * is the part that must be provable, and a rule that needs a database to
 * demonstrate is a rule nobody will write a test for. The assembler gathers,
 * this decides, the controller reports; no health logic lives anywhere else and
 * none of it lives in React.
 *
 * Three principles govern every rule below.
 *
 * **A failure is a health problem; a preference is not.** A missing aired
 * episode, a failed intake and a broken identity are defects. Missing optional
 * subtitles, a 1080p file when 2160p exists, media nobody watched for two
 * years, and a torrent that stopped seeding are *not* — not until a policy
 * exists that says otherwise, and Phase 1 defines no such policy. Those are
 * recorded as informational findings so the facts stay visible without the
 * library being slandered as unhealthy.
 *
 * **UNKNOWN is not a failure and not a zero.** A file nobody has probed is
 * unmeasured, not defective. Health becomes `unknown` only when the facts that
 * would let us judge are themselves missing — never as a way of expressing
 * "something is wrong".
 *
 * **Aggregation is severity-aware, never arithmetic.** One critical failure
 * beside ten healthy domains is a critical entity. Averaging is how a broken
 * thing scores 72 and gets called "mostly healthy".
 */

/** Severity → the floor it imposes on overall health. */
const SEVERITY_FLOOR: Readonly<Record<MediaFindingSeverity, MediaHealthStatus>> = {
  info: 'healthy',
  opportunity: 'healthy',
  warning: 'attention',
  error: 'degraded',
  critical: 'critical',
};

/** Worst-first ordering, used to rank both statuses and reasons. */
const STATUS_RANK: Readonly<Record<MediaHealthStatus, number>> = {
  healthy: 0,
  unknown: 1,
  attention: 2,
  degraded: 3,
  critical: 4,
};

const SEVERITY_RANK: Readonly<Record<MediaFindingSeverity, number>> = {
  info: 0,
  opportunity: 1,
  warning: 2,
  error: 3,
  critical: 4,
};

/** How many sample items a finding may carry. Evidence must stay bounded. */
export const MAX_EVIDENCE_SAMPLE = 10;

/**
 * Domains whose absence makes the whole verdict meaningless.
 *
 * If we cannot tell what something *is* or whether it is even on disk, calling
 * it "healthy" is a guess dressed as a conclusion. Every other domain can be
 * unknown without poisoning the overall answer — an unprobed file or an
 * unmappable play count leaves the rest perfectly judgeable.
 */
const ESSENTIAL_DOMAINS: readonly MediaIntelligenceDomain[] = ['identity', 'library'];

export interface EvaluationInput {
  entityType: MediaIntelligenceEntityType;
  entityId: string;
  /** Every section except the conclusions the evaluator is about to draw. */
  facts: Omit<UnifiedMediaState, 'health' | 'findings' | 'freshness'>;
  /** Injected so evaluation is reproducible in tests. */
  now: Date;
  /** Hygiene score from the Media Manager's existing scorer, when available. */
  hygieneScore?: number | null;
}

export interface EvaluationResult {
  health: MediaHealthSummary;
  findings: MediaFinding[];
}

/** Build a finding from its catalogued classification plus bounded evidence. */
function finding(
  code: MediaFindingCodeValue,
  input: EvaluationInput,
  source: string,
  evidence: Record<string, unknown>,
): MediaFinding {
  const def = MEDIA_FINDING_DEFINITIONS[code];
  return {
    code,
    domain: def.domain,
    severity: def.severity,
    entityType: input.entityType,
    entityId: input.entityId,
    evidence,
    source,
    // Lifecycle timestamps are owned by the store, which knows whether this
    // finding is new or a re-observation. The evaluator is stateless.
    firstObservedAt: null,
    lastObservedAt: input.now.toISOString(),
    actionable: Boolean(def.actionCapabilityIds?.length),
    ...(def.actionCapabilityIds ? { actionCapabilityIds: def.actionCapabilityIds } : {}),
  };
}

/* ------------------------------------------------------------------- rules */

/**
 * Identity.
 *
 * The trap here is `confidence = 0` / `matchStatus = 'unmatched'`. Every intake
 * import looks like that while still carrying a correct title, season and
 * episode, because the scanner writes those and leaves the match fields at
 * their defaults. Treating that as a broken identity would flag a large,
 * perfectly healthy slice of the library. So the finding requires a real
 * absence of identity: nothing matched AND no external id to fall back on.
 */
function evaluateIdentity(input: EvaluationInput, out: MediaFinding[]): void {
  const id = input.facts.identity;
  if (id.status === 'unknown') return;

  const hasExternalId = Object.keys(id.externalIds ?? {}).length > 0;
  const unmatched = id.matchStatus === 'unmatched';
  if (unmatched && !hasExternalId) {
    out.push(
      finding(MEDIA_FINDING_CODES.IDENTITY_UNRESOLVED, input, 'media_manager', {
        matchStatus: id.matchStatus,
        hasExternalId: false,
        // Recorded so the UI can say "we do know it is called X" rather than
        // implying the row is anonymous.
        knownTitle: id.title,
      }),
    );
  }

  if (id.conflictingExternalIds) {
    out.push(
      finding(MEDIA_FINDING_CODES.IDENTITY_EXTERNAL_ID_CONFLICT, input, 'media_manager', {
        externalIds: id.externalIds,
      }),
    );
  }
}

/** Library: the only judgement Phase 1 makes is "was this ever observed". */
function evaluateLibrary(input: EvaluationInput, out: MediaFinding[]): void {
  const lib = input.facts.library;
  if (lib.status === 'unknown') return;
  if (lib.present === true && lib.lastScanAt === null) {
    out.push(
      finding(MEDIA_FINDING_CODES.LIBRARY_NEVER_SCANNED, input, 'media_manager', {
        libraryId: lib.libraryId,
        libraryName: lib.libraryName,
      }),
    );
  }
}

/**
 * Completeness.
 *
 * `missing` from Missing Episodes already excludes unaired, ignored and
 * out-of-scope episodes — that classification is the acquisition domain's job
 * and re-deriving it here would be the second implementation that drifts. So a
 * non-zero `missing` is, by construction, aired-and-wanted-and-absent.
 */
function evaluateCompleteness(input: EvaluationInput, out: MediaFinding[]): void {
  const c = input.facts.completeness;
  if (c.status === 'unknown' || c.missing === null || c.missing <= 0) return;

  out.push(
    finding(MEDIA_FINDING_CODES.EPISODES_MISSING, input, 'media_acquisition', {
      missing: c.missing,
      expected: c.expected,
      owned: c.owned,
      // Unaired/ignored are carried so the sentence can say "3 aired episodes
      // are missing" without the reader wondering about the other gaps.
      unaired: c.unaired,
      ignored: c.ignored,
    }),
  );
}

/**
 * Technical.
 *
 * Only ever informational. An unprobed file is pending measurement, and the
 * probe backfill is already working through the library on its own schedule;
 * shouting about it would turn a normal steady state into a permanent alarm.
 * Files the probe permanently gave up on are reported separately in evidence.
 */
function evaluateTechnical(input: EvaluationInput, out: MediaFinding[]): void {
  const t = input.facts.technical;
  const measured = t.measuredFileCount ?? 0;
  const unprobed = t.unprobedFileCount ?? 0;
  const unmeasurable = t.unmeasurableFileCount ?? 0;
  if (measured > 0 || (unprobed === 0 && unmeasurable === 0)) return;

  out.push(
    finding(MEDIA_FINDING_CODES.MEDIA_TECHNICAL_DATA_MISSING, input, 'media_manager', {
      unprobedFiles: unprobed,
      unmeasurableFiles: unmeasurable,
    }),
  );
}

/**
 * Metadata.
 *
 * `provider === null` is the repository's own "never successfully enriched"
 * signal — the metadata service writes null deliberately so the row re-enters
 * the enrichment gap query. There is no `lastFetchedAt` anywhere, so Phase 1
 * makes no staleness claim at all rather than inventing one from `updatedAt`,
 * which also moves on a manual edit.
 */
function evaluateMetadata(input: EvaluationInput, out: MediaFinding[]): void {
  const m = input.facts.metadata;
  if (m.status === 'unknown') return;
  if (m.provider === null) {
    out.push(
      finding(MEDIA_FINDING_CODES.METADATA_INCOMPLETE, input, 'media_manager', {
        provider: null,
        hasOverview: m.hasOverview,
      }),
    );
  }
}

/** Artwork: measured against the baseline the Media Manager already defines. */
function evaluateArtwork(input: EvaluationInput, out: MediaFinding[]): void {
  const a = input.facts.artwork;
  if (a.status === 'unknown' || a.missingRequiredCount === null || a.missingRequiredCount <= 0) return;
  out.push(
    finding(MEDIA_FINDING_CODES.ARTWORK_INCOMPLETE, input, 'media_manager', {
      missingRequired: a.missingRequiredCount,
      posterPresent: a.posterPresent,
      fanartPresent: a.fanartPresent,
    }),
  );
}

/**
 * Subtitles — factual coverage only.
 *
 * Informational by classification, and gated further: because embedded tracks
 * are not modelled anywhere, "no sidecar rows" cannot be reported as "no
 * subtitles". The finding is raised only for a genuine *partial* coverage gap,
 * where some items in the same entity demonstrably have subtitles and others
 * demonstrably do not — a comparison that stays true whatever is baked into the
 * containers.
 */
function evaluateSubtitles(input: EvaluationInput, out: MediaFinding[]): void {
  const s = input.facts.subtitles;
  if (s.status === 'unknown' || s.itemsTotal === null || s.itemsWithSubtitles === null) return;
  const withSubs = s.itemsWithSubtitles;
  const total = s.itemsTotal;
  if (total <= 1 || withSubs <= 0 || withSubs >= total) return;

  out.push(
    finding(MEDIA_FINDING_CODES.SUBTITLE_COVERAGE_INCOMPLETE, input, 'media_manager', {
      withSubtitles: withSubs,
      total,
      without: total - withSubs,
      languages: s.languages.slice(0, MAX_EVIDENCE_SAMPLE),
    }),
  );
}

/**
 * Acquisition.
 *
 * Only monitored media can be judged here: an unmonitored show is a choice, not
 * a fault. A Backfill-Only add deliberately has no rule and grabs through the
 * global preference ladder, so "no rule" is only a problem when the entity is
 * supposed to be monitoring for new releases.
 */
function evaluateAcquisition(input: EvaluationInput, out: MediaFinding[]): void {
  const a = input.facts.acquisition;
  if (a.status === 'unknown' || a.monitored !== true) return;

  if (a.usesGlobalPreferences !== true && a.ruleId !== null && a.ruleEnabled === false) {
    out.push(
      finding(MEDIA_FINDING_CODES.ACQUISITION_NOT_READY, input, 'media_acquisition', {
        ruleId: a.ruleId,
        ruleEnabled: false,
      }),
    );
  }

  // Repeated indexer failure is a real operational fault; "no results" is not —
  // a release that does not exist is the world's answer, not a defect.
  if ((a.searchesFailed ?? 0) > 0) {
    out.push(
      finding(MEDIA_FINDING_CODES.ACQUISITION_SEARCH_FAILING, input, 'media_acquisition', {
        failed: a.searchesFailed,
        noResults: a.searchesNoResults,
        lastSearchAt: a.lastSearchAt,
      }),
    );
  }
}

/** Intake: a failed or quarantined import is unambiguously a defect. */
function evaluateIntake(input: EvaluationInput, out: MediaFinding[]): void {
  const i = input.facts.intake;
  if (i.status === 'unknown') return;

  if ((i.failed ?? 0) > 0) {
    out.push(
      finding(MEDIA_FINDING_CODES.INTAKE_FAILED, input, 'media_intake', {
        failed: i.failed,
        lastError: i.lastError,
        lastIntakeAt: i.lastIntakeAt,
      }),
    );
  }
  if ((i.quarantined ?? 0) > 0) {
    out.push(
      finding(MEDIA_FINDING_CODES.INTAKE_QUARANTINED, input, 'media_intake', {
        quarantined: i.quarantined,
      }),
    );
  }
}

/**
 * Torrent.
 *
 * Deliberately narrow. "Not seeding" is not a defect — no Phase 1 policy
 * requires seeding, and most library media never came through a torrent at all
 * and so has no association to judge. Only an engine-reported error state is a
 * finding.
 */
function evaluateTorrent(input: EvaluationInput, out: MediaFinding[]): void {
  const t = input.facts.torrent;
  if (t.status === 'unknown' || (t.erroredCount ?? 0) <= 0) return;
  out.push(
    finding(MEDIA_FINDING_CODES.TORRENT_ERROR, input, 'torrents', {
      errored: t.erroredCount,
      associated: t.associatedCount,
    }),
  );
}

/** Storage: duplicates want review and cost space; they are not corruption. */
function evaluateStorage(input: EvaluationInput, out: MediaFinding[]): void {
  const lib = input.facts.library;
  if (lib.status === 'unknown' || (lib.duplicateGroupCount ?? 0) <= 0) return;
  out.push(
    finding(MEDIA_FINDING_CODES.DUPLICATE_MEDIA_PRESENT, input, 'media_manager', {
      groups: lib.duplicateGroupCount,
      reclaimableBytes: lib.duplicateReclaimableBytes,
    }),
  );
}

/*
 * Usage is intentionally absent.
 *
 * Nothing about how often something was watched makes it healthy or unhealthy.
 * Age is not decay, and "never played" is frequently just "imported last
 * night". Usage is reported in the state and drives no finding in Phase 1.
 */

/* --------------------------------------------------------------- aggregation */

function worst(a: MediaHealthStatus, b: MediaHealthStatus): MediaHealthStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

/**
 * Per-domain status.
 *
 * A domain is `unknown` only when it produced no findings AND its facts could
 * not be read — an unknown section that nonetheless yielded a finding is
 * evidently knowable enough to judge.
 */
function domainHealth(
  input: EvaluationInput,
  findings: MediaFinding[],
): MediaDomainHealth[] {
  const facts = input.facts as unknown as Record<string, { status?: string } | undefined>;
  return MEDIA_INTELLIGENCE_DOMAINS.map((domain) => {
    const own = findings.filter((f) => f.domain === domain);
    let status: MediaHealthStatus = 'healthy';
    for (const f of own) status = worst(status, SEVERITY_FLOOR[f.severity]);

    if (own.length === 0) {
      // `storage` draws its facts from the library section; everything else
      // shares its own name with its section.
      const sectionKey = domain === 'storage' ? 'storage' : domain;
      const section = facts[sectionKey];
      if (section?.status === 'unknown') status = 'unknown';
    }

    return { domain, status, findingCodes: own.map((f) => f.code) };
  });
}

/**
 * Overall health.
 *
 * Severity-aware: the worst finding sets the floor. `unknown` is reserved for
 * the case where an essential domain could not be read at all — it outranks
 * `healthy` (we should not claim health we cannot demonstrate) but never
 * outranks a real problem, because a genuine defect is more informative than an
 * unreadable section.
 */
function overallStatus(input: EvaluationInput, findings: MediaFinding[]): MediaHealthStatus {
  let status: MediaHealthStatus = 'healthy';
  for (const f of findings) {
    if (!HEALTH_AFFECTING_SEVERITIES.includes(f.severity)) continue;
    status = worst(status, SEVERITY_FLOOR[f.severity]);
  }

  if (status === 'healthy') {
    const facts = input.facts as unknown as Record<string, { status?: string } | undefined>;
    const blind = ESSENTIAL_DOMAINS.every((d) => facts[d]?.status === 'unknown');
    if (blind) return 'unknown';
  }
  return status;
}

/**
 * Evaluate one entity.
 *
 * Deterministic and idempotent: the same facts always yield the same findings
 * in the same order, which is what lets the projection store detect "nothing
 * changed" instead of rewriting rows every sweep.
 */
export function evaluateMediaHealth(input: EvaluationInput): EvaluationResult {
  const findings: MediaFinding[] = [];

  evaluateIdentity(input, findings);
  evaluateLibrary(input, findings);
  evaluateCompleteness(input, findings);
  evaluateTechnical(input, findings);
  evaluateMetadata(input, findings);
  evaluateArtwork(input, findings);
  evaluateSubtitles(input, findings);
  evaluateAcquisition(input, findings);
  evaluateIntake(input, findings);
  evaluateTorrent(input, findings);
  evaluateStorage(input, findings);
  evaluateQuality(input, findings);

  // Stable worst-first ordering so a UI never has to sort and two runs over
  // identical facts are byte-comparable.
  findings.sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.code.localeCompare(b.code),
  );

  const status = overallStatus(input, findings);
  const reasons = findings
    .filter((f) => HEALTH_AFFECTING_SEVERITIES.includes(f.severity))
    .map((f) => f.code);

  return {
    health: {
      status,
      score: input.hygieneScore ?? null,
      domains: domainHealth(input, findings),
      reasons,
    },
    findings,
  };
}

/**
 * Quality compliance against the operator's OWN acquisition ladder.
 *
 * Silent in three cases, all of them deliberate:
 *
 *  - **No ladder configured.** Absence of a policy is not a verdict. Saying
 *    anything here would mean inventing a preference the operator never set.
 *  - **Nothing measurable.** An unprobed file, or a ladder that only asks for
 *    release-name facts a renamed file has lost, yields no finding — Phase 1's
 *    `MEDIA_TECHNICAL_DATA_MISSING` already reports absent measurement, and a
 *    second finding for the same gap would double-count it.
 *  - **Preferred rung matched.** Nothing to say.
 *
 * The two findings it does emit are graded apart on purpose. Satisfying a
 * fallback the operator themselves configured is an OPPORTUNITY; satisfying
 * nothing they configured is a WARNING. Neither is an error: the media plays.
 */
function evaluateQuality(input: EvaluationInput, out: MediaFinding[]): void {
  const q = (input.facts as { quality?: MediaQualityFacts }).quality;
  if (!q) return;
  const c = q.compliance;
  if (c.status === 'unknown' || c.status === 'preferred') return;

  // Only the dimensions that actually decided the verdict, capped — evidence
  // must explain without becoming a copy of the file's technical profile.
  const blocking = boundedSample(
    c.dimensions.filter((d) => d.result === 'fail').map((d) => `${d.dimension}:${d.required ?? '?'}`),
    5,
  );

  if (c.status === 'below_preference') {
    out.push(
      finding(MEDIA_FINDING_CODES.QUALITY_BELOW_PREFERENCE, input, 'media_acquisition', {
        ownedResolution: q.owned?.resolutionClass ?? null,
        ownedCodec: q.owned?.videoCodec ?? null,
        preferenceSource: c.preferenceSource,
        totalRungs: c.totalRungs,
        blockedBy: blocking.sample,
        ...(blocking.omitted ? { omitted: blocking.omitted } : {}),
        measuredFileCount: q.measuredFileCount,
      }),
    );
    return;
  }

  // `acceptable` with a better rung above it.
  if (c.upgradePotential) {
    out.push(
      finding(MEDIA_FINDING_CODES.QUALITY_UPGRADE_POTENTIAL, input, 'media_acquisition', {
        ownedResolution: q.owned?.resolutionClass ?? null,
        matchedRung: c.matchedRung,
        matchedRungName: c.matchedRungName,
        preferredRung: c.preferredRung,
        totalRungs: c.totalRungs,
        preferenceSource: c.preferenceSource,
        // Named so nobody reads this as "a better release was found".
        upgradeAvailable: false,
      }),
    );
  }
}

/** Bound an evidence list so a large series cannot inflate every response. */
export function boundedSample<T>(values: readonly T[], max = MAX_EVIDENCE_SAMPLE): { sample: T[]; omitted: number } {
  return { sample: values.slice(0, max), omitted: Math.max(0, values.length - max) };
}
