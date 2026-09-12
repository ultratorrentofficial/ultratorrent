import { Injectable } from '@nestjs/common';
import { SettingsService } from '../../settings/settings.module';
import { DEFAULT_THRESHOLDS, HouseholdThresholds, RISK_LEVELS, RiskLevel } from './household-types';

export const HOUSEHOLD_SETTINGS_KEY = 'media_server_analytics.household';

/**
 * Household & Sharing configuration. Advisory by default: analysis runs when
 * analytics/IP data exists, but nothing is enforced and notifications are off —
 * upgrading never surprises an operator by terminating streams.
 */
export interface HouseholdSettings extends HouseholdThresholds {
  /** Master switch for learning + scoring. */
  enabled: boolean;
  /** Emit notifications on meaningful transitions (off by default). */
  notify: boolean;
  /** Minimum level that notifies (when `notify` is on). */
  notifyLevel: RiskLevel;
}

export type HouseholdSettingsPatch = Partial<HouseholdSettings>;

const DEFAULTS: HouseholdSettings = {
  ...DEFAULT_THRESHOLDS,
  enabled: true,
  notify: false,
  notifyLevel: 'high',
};

const clampInt = (v: unknown, min: number, max: number, fb: number): number => {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fb;
};
const level = (v: unknown, fb: RiskLevel): RiskLevel => (RISK_LEVELS.includes(v as RiskLevel) ? (v as RiskLevel) : fb);

@Injectable()
export class HouseholdSettingsService {
  constructor(private readonly settings: SettingsService) {}

  async read(): Promise<HouseholdSettings> {
    const s = (await this.settings.get<Record<string, unknown>>(HOUSEHOLD_SETTINGS_KEY)) ?? {};
    return {
      enabled: typeof s.enabled === 'boolean' ? s.enabled : DEFAULTS.enabled,
      notify: typeof s.notify === 'boolean' ? s.notify : DEFAULTS.notify,
      notifyLevel: level(s.notifyLevel, DEFAULTS.notifyLevel),
      minHomeAgeDays: clampInt(s.minHomeAgeDays, 0, 365, DEFAULTS.minHomeAgeDays),
      minHomeDistinctDays: clampInt(s.minHomeDistinctDays, 1, 365, DEFAULTS.minHomeDistinctDays),
      minHomePlays: clampInt(s.minHomePlays, 1, 1000, DEFAULTS.minHomePlays),
      minHomeWatchSeconds: clampInt(s.minHomeWatchSeconds, 0, 10_000_000, DEFAULTS.minHomeWatchSeconds),
      secondaryResidentialDays: clampInt(s.secondaryResidentialDays, 1, 365, DEFAULTS.secondaryResidentialDays),
      largeSeparationKm: clampInt(s.largeSeparationKm, 50, 20000, DEFAULTS.largeSeparationKm),
      reviewLevel: level(s.reviewLevel, DEFAULTS.reviewLevel),
    };
  }

  async update(patch: HouseholdSettingsPatch): Promise<HouseholdSettings> {
    const cur = await this.read();
    const next: HouseholdSettings = { ...cur };
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    if (typeof patch.notify === 'boolean') next.notify = patch.notify;
    if (patch.notifyLevel) next.notifyLevel = level(patch.notifyLevel, cur.notifyLevel);
    if ('minHomeAgeDays' in patch) next.minHomeAgeDays = clampInt(patch.minHomeAgeDays, 0, 365, cur.minHomeAgeDays);
    if ('minHomeDistinctDays' in patch) next.minHomeDistinctDays = clampInt(patch.minHomeDistinctDays, 1, 365, cur.minHomeDistinctDays);
    if ('minHomePlays' in patch) next.minHomePlays = clampInt(patch.minHomePlays, 1, 1000, cur.minHomePlays);
    if ('minHomeWatchSeconds' in patch) next.minHomeWatchSeconds = clampInt(patch.minHomeWatchSeconds, 0, 10_000_000, cur.minHomeWatchSeconds);
    if ('secondaryResidentialDays' in patch) next.secondaryResidentialDays = clampInt(patch.secondaryResidentialDays, 1, 365, cur.secondaryResidentialDays);
    if ('largeSeparationKm' in patch) next.largeSeparationKm = clampInt(patch.largeSeparationKm, 50, 20000, cur.largeSeparationKm);
    if (patch.reviewLevel) next.reviewLevel = level(patch.reviewLevel, cur.reviewLevel);
    await this.settings.set(HOUSEHOLD_SETTINGS_KEY, next as unknown as Record<string, unknown>);
    return next;
  }
}
