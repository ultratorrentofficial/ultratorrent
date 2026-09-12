import {
  DEFAULT_THRESHOLDS,
  HouseholdThresholds,
  NetworkAgg,
  ReasonEntry,
  RiskResult,
  SessionWindow,
  levelAtLeast,
  levelForScore,
} from './household-types';

/** Score deltas — tunable in one place, never scattered through the logic. */
const D = {
  newResidential: 8,
  persistentSecondaryResidential: 20,
  vpnOrHosting: 12,
  simultaneousResidential: 30,
  repeatedSimultaneous: 20,
  concurrentDifferentDevices: 8,
  largeGeographicSeparation: 12,
  trustedNetwork: -5,
} as const;

export interface HouseholdEvalInput {
  networks: NetworkAgg[];
  /** Playback windows (from watch history / live sessions) for overlap detection. */
  windows: SessionWindow[];
  currentHomeId: string | null;
  homeLocked: boolean;
  thresholds?: Partial<HouseholdThresholds>;
  now?: Date;
}

export interface HouseholdEvalResult {
  homeNetworkId: string | null;
  homeConfidence: number;
  /** What the learner WOULD pick — surfaced when the home is locked but stale. */
  suggestedHomeId: string | null;
  risk: RiskResult;
}

const dayMs = 86_400_000;
const ageDays = (from: Date | null, now: number): number => (from ? (now - from.getTime()) / dayMs : 0);

/** A residential network counts toward home learning only with enough real evidence. */
function homeEligible(n: NetworkAgg, th: HouseholdThresholds, now: number): boolean {
  return (
    n.networkType === 'residential' &&
    !n.ignored &&
    n.distinctDays >= th.minHomeDistinctDays &&
    n.playCount >= th.minHomePlays &&
    n.watchSeconds >= th.minHomeWatchSeconds &&
    ageDays(n.firstSeenAt, now) >= th.minHomeAgeDays
  );
}

/**
 * Weighted home score (0–100) — never a simple majority of play count, and
 * deliberately NOT influenced by `trusted`: the home is learned from evidence
 * (watch time, distinct days, plays, recency), while trust is a separate admin
 * signal that neutralizes RISK, not which network is home.
 */
function homeScore(n: NetworkAgg, now: number): number {
  const watch = Math.min(n.watchSeconds / 36000, 1) * 40; // ~10h caps
  const days = Math.min(n.distinctDays / 30, 1) * 25;
  const plays = Math.min(n.playCount / 20, 1) * 15;
  const recencyDays = ageDays(n.lastSeenAt, now);
  const recency = Math.max(0, 1 - recencyDays / 30) * 20; // seen in last month → strong
  return watch + days + plays + recency;
}

export function inferHome(
  networks: NetworkAgg[],
  th: HouseholdThresholds,
  now: number,
): { homeId: string | null; confidence: number } {
  const eligible = networks.filter((n) => homeEligible(n, th, now));
  if (eligible.length === 0) return { homeId: null, confidence: 0 };
  const scored = eligible.map((n) => ({ n, s: homeScore(n, now) })).sort((a, b) => b.s - a.s);
  const winner = scored[0];
  const runner = scored[1];
  let confidence = Math.round(Math.min(100, winner.s));
  // A close residential runner-up means a second legitimate home may exist —
  // don't over-claim confidence in a single home.
  if (runner && runner.s > winner.s * 0.7) confidence = Math.min(confidence, 70);
  return { homeId: winner.n.id, confidence };
}

export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Distinct days on which two networks' windows overlapped, plus whether any
 * overlapping pair used different device families. Overlap is real interval
 * intersection — sequential sessions with close timestamps do NOT count. */
function overlap(aWins: SessionWindow[], bWins: SessionWindow[]): { days: Set<number>; differentDevices: boolean } {
  const days = new Set<number>();
  let differentDevices = false;
  for (const a of aWins) {
    for (const b of bWins) {
      if (a.startedAt.getTime() < b.endedAt.getTime() && b.startedAt.getTime() < a.endedAt.getTime()) {
        days.add(Math.floor(Math.max(a.startedAt.getTime(), b.startedAt.getTime()) / dayMs));
        if (a.deviceFamily && b.deviceFamily && a.deviceFamily !== b.deviceFamily) differentDevices = true;
      }
    }
  }
  return { days, differentDevices };
}

/**
 * The heart: derive an explainable risk score from MULTIPLE signals. Mobile is
 * neutral, travel/trusted are discounted, VPN/hosting is review-not-confirmed,
 * and simultaneous residential streams (real overlap) dominate. Every contribution
 * is a reason code with a delta and details — no score without an explanation.
 */
export function evaluateRisk(input: HouseholdEvalInput, homeId: string | null): RiskResult {
  const th = { ...DEFAULT_THRESHOLDS, ...(input.thresholds ?? {}) };
  const reasons: ReasonEntry[] = [];
  const add = (code: string, delta: number, details?: Record<string, unknown>) => reasons.push({ code, delta, details });

  const byId = new Map(input.networks.map((n) => [n.id, n]));
  const contributing = new Set<string>(); // residential remotes that added risk

  if (input.networks.some((n) => n.networkType === 'mobile')) add('mobile_networks_present', 0);

  for (const n of input.networks) {
    if (n.id === homeId || n.ignored) continue;
    if (n.networkType === 'mobile') continue; // neutral — never raises risk on its own
    if (n.disposition === 'travel') { add('travel_network', 0, { networkId: n.id }); continue; }
    if (n.trusted) { add('trusted_network', D.trustedNetwork, { networkId: n.id }); continue; }
    if (n.networkType === 'vpn_proxy' || n.networkType === 'hosting') {
      add('vpn_or_hosting_network', D.vpnOrHosting, { networkId: n.id, type: n.networkType });
      continue;
    }
    if (n.networkType === 'residential') {
      if (n.distinctDays >= th.secondaryResidentialDays) {
        add('persistent_secondary_residential_network', D.persistentSecondaryResidential, { networkId: n.id, distinctDays: n.distinctDays });
      } else {
        add('new_residential_network', D.newResidential, { networkId: n.id });
      }
      contributing.add(n.id);
    }
  }

  // Simultaneity — real overlap between two DISTINCT residential networks that are
  // not ignored/trusted/travel/mobile. Home-independent: two "homes" at once is the
  // core signal whichever one is nominally home.
  const residentialLive = input.networks.filter(
    (n) => n.networkType === 'residential' && !n.ignored && !n.trusted && n.disposition !== 'travel',
  );
  const winsByNet = new Map<string, SessionWindow[]>();
  for (const w of input.windows) (winsByNet.get(w.networkId) ?? winsByNet.set(w.networkId, []).get(w.networkId)!).push(w);

  let simultaneousDays = 0;
  let anyDifferentDevices = false;
  const simPairs: Array<{ a: string; b: string; days: number }> = [];
  for (let i = 0; i < residentialLive.length; i += 1) {
    for (let j = i + 1; j < residentialLive.length; j += 1) {
      const a = residentialLive[i], b = residentialLive[j];
      const o = overlap(winsByNet.get(a.id) ?? [], winsByNet.get(b.id) ?? []);
      if (o.days.size > 0) {
        simultaneousDays = Math.max(simultaneousDays, o.days.size);
        if (o.differentDevices) anyDifferentDevices = true;
        simPairs.push({ a: a.id, b: b.id, days: o.days.size });
      }
    }
  }

  if (simPairs.length > 0) {
    add('simultaneous_residential_networks', D.simultaneousResidential, { pairs: simPairs });
    if (simultaneousDays >= 2) add('repeated_simultaneous_usage', D.repeatedSimultaneous, { days: simultaneousDays });
    if (anyDifferentDevices) add('concurrent_different_devices', D.concurrentDifferentDevices);
    simPairs.forEach((p) => { contributing.add(p.a); contributing.add(p.b); });
  }

  // Large geographic separation — only alongside another residential/simultaneous
  // reason, and only with real coordinates (never claimed as exact location).
  const home = homeId ? byId.get(homeId) : residentialLive.sort((a, b) => b.watchSeconds - a.watchSeconds)[0];
  if (home?.latitude != null && home.longitude != null) {
    for (const n of input.networks) {
      if (!contributing.has(n.id) || n.latitude == null || n.longitude == null) continue;
      const km = haversineKm(home.latitude, home.longitude, n.latitude, n.longitude);
      if (km >= th.largeSeparationKm) {
        add('large_geographic_separation', D.largeGeographicSeparation, { networkId: n.id, kmBand: coarseBand(km) });
        break;
      }
    }
  }

  const score = Math.max(0, Math.min(100, reasons.reduce((s, r) => s + r.delta, 0)));
  const level = levelForScore(score);
  const reviewRequired = simPairs.length > 0 || levelAtLeast(level, th.reviewLevel);
  return { score, level, reasons, reviewRequired };
}

/** Coarse distance band — GeoIP is approximate, so never a precise number. */
function coarseBand(km: number): string {
  if (km < 100) return '<100km';
  if (km < 500) return '100-500km';
  if (km < 2000) return '500-2000km';
  return '2000km+';
}

export function evaluateHousehold(input: HouseholdEvalInput): HouseholdEvalResult {
  const th = { ...DEFAULT_THRESHOLDS, ...(input.thresholds ?? {}) };
  const now = (input.now ?? new Date()).getTime();
  const learned = inferHome(input.networks, th, now);

  // A locked home is never auto-replaced; the learner's pick is surfaced as a
  // suggestion so a stale lock can be flagged to the admin instead.
  const homeNetworkId = input.homeLocked && input.currentHomeId ? input.currentHomeId : learned.homeId;
  const homeConfidence = input.homeLocked && input.currentHomeId
    ? (input.networks.find((n) => n.id === input.currentHomeId) ? Math.round(homeScore(input.networks.find((n) => n.id === input.currentHomeId)!, now)) : 0)
    : learned.confidence;
  const suggestedHomeId = input.homeLocked ? learned.homeId : null;

  const risk = evaluateRisk(input, homeNetworkId);
  return { homeNetworkId, homeConfidence, suggestedHomeId, risk };
}
