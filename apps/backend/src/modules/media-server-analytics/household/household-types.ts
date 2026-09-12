/**
 * Household & Sharing — pure domain types.
 *
 * Everything here is provider-agnostic and free of Prisma/HTTP so the learning
 * and risk logic can be exercised in isolation (the 22 spec scenarios are unit
 * tests over these types). Sharing risk is derived from MULTIPLE explainable
 * signals; a different IP alone is never evidence.
 */

/** Normalized network class. Broad on purpose where source data cannot be sure. */
export type NetworkType = 'residential' | 'mobile' | 'hosting' | 'vpn_proxy' | 'unknown';
export const NETWORK_TYPES: NetworkType[] = ['residential', 'mobile', 'hosting', 'vpn_proxy', 'unknown'];

export type RiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

/** One explainable contribution to a risk score. `code` is localized client-side. */
export interface ReasonEntry {
  code: string;
  delta: number;
  details?: Record<string, unknown>;
}

export interface RiskResult {
  score: number;
  level: RiskLevel;
  reasons: ReasonEntry[];
  reviewRequired: boolean;
}

/** The normalized geo/network facts for one address (a projection of GeoResult). */
export interface NetworkFacts {
  ip: string;
  kind: 'private' | 'public' | 'unknown';
  asn: number | null;
  isp: string | null;
  countryCode: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface Fingerprint {
  /** Stable cluster key — an ISP+city, NOT one exact IP. `null` = not a real network. */
  fingerprint: string | null;
  representativeIp: string | null;
  asn: number | null;
  isp: string | null;
  countryCode: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
}

/** A network aggregate as the evaluator reads it (a projection of the DB row). */
export interface NetworkAgg {
  id: string;
  fingerprint: string;
  networkType: NetworkType;
  playCount: number;
  watchSeconds: number;
  distinctDays: number;
  uniqueDevices: number;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  trusted: boolean;
  ignored: boolean;
  /** null | 'travel' | 'mobile' — admin disposition. */
  disposition: string | null;
  latitude: number | null;
  longitude: number | null;
  city: string | null;
  isp: string | null;
}

/** A playback window on a given network, for overlap (simultaneity) detection. */
export interface SessionWindow {
  networkId: string;
  startedAt: Date;
  endedAt: Date;
  deviceFamily: string | null;
}

/** Tunable thresholds (defaults live in the settings service). */
export interface HouseholdThresholds {
  minHomeAgeDays: number;
  minHomeDistinctDays: number;
  minHomePlays: number;
  minHomeWatchSeconds: number;
  secondaryResidentialDays: number;
  largeSeparationKm: number;
  /** score ≥ this level opens a review. */
  reviewLevel: RiskLevel;
}

export const DEFAULT_THRESHOLDS: HouseholdThresholds = {
  minHomeAgeDays: 7,
  minHomeDistinctDays: 3,
  minHomePlays: 3,
  minHomeWatchSeconds: 3600,
  secondaryResidentialDays: 3,
  largeSeparationKm: 500,
  reviewLevel: 'high',
};

export const RISK_LEVELS: RiskLevel[] = ['none', 'low', 'medium', 'high', 'critical'];

/** Map a 0–100 score to a level. Tunable, but kept monotonic. */
export function levelForScore(score: number): RiskLevel {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 30) return 'medium';
  if (score >= 10) return 'low';
  return 'none';
}

const ORDER: Record<RiskLevel, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
export function levelAtLeast(a: RiskLevel, b: RiskLevel): boolean {
  return ORDER[a] >= ORDER[b];
}
