import { Injectable } from '@nestjs/common';
import { SettingsService } from '../../settings/settings.module';

/** Where an over-limit account's excess streams are chosen from, or a softer action. */
export type EnforcementAction = 'terminate_newest' | 'terminate_oldest' | 'warn' | 'log';
export const ENFORCEMENT_ACTIONS: EnforcementAction[] = ['terminate_newest', 'terminate_oldest', 'warn', 'log'];

/** How streams are grouped when counting against a limit. */
export type EnforcementScope = 'all_servers' | 'per_server';
export const ENFORCEMENT_SCOPES: EnforcementScope[] = ['all_servers', 'per_server'];

export const STREAM_CONTROL_SETTINGS_KEY = 'media_server_analytics.stream_control';

/** Global Stream Control configuration. Per-user/per-server overrides live in the
 * `MediaStreamPolicy` table; these are the defaults everything inherits. */
export interface StreamControlSettings {
  /** Master switch. Enforcement never acts while this is false (spec §3). */
  enabled: boolean;
  /** Global default limit; null = unlimited. */
  defaultLimit: number | null;
  defaultAction: EnforcementAction;
  gracePeriodSeconds: number;
  countPaused: boolean;
  /** A paused session older than this stops counting (0 = never expire). */
  pausedExpirationMinutes: number;
  scope: EnforcementScope;
}

export type StreamControlSettingsPatch = Partial<StreamControlSettings>;

const DEFAULTS: StreamControlSettings = {
  enabled: false,
  defaultLimit: null,
  defaultAction: 'terminate_newest',
  // 60s so a transient over-limit — a pause registering, a device handoff whose old
  // session is still winding down (marked ended after ~4 missed polls ≈ 60s), a
  // brief re-buffer — resolves before we ever terminate.
  gracePeriodSeconds: 60,
  countPaused: true,
  pausedExpirationMinutes: 5,
  scope: 'all_servers',
};

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

@Injectable()
export class StreamControlSettingsService {
  constructor(private readonly settings: SettingsService) {}

  async read(): Promise<StreamControlSettings> {
    const stored = (await this.settings.get<Record<string, unknown>>(STREAM_CONTROL_SETTINGS_KEY)) ?? {};
    const action = ENFORCEMENT_ACTIONS.includes(stored.defaultAction as EnforcementAction)
      ? (stored.defaultAction as EnforcementAction)
      : DEFAULTS.defaultAction;
    const scope = ENFORCEMENT_SCOPES.includes(stored.scope as EnforcementScope)
      ? (stored.scope as EnforcementScope)
      : DEFAULTS.scope;
    // null stays null (unlimited); a number is clamped to 1..100.
    const rawLimit = stored.defaultLimit;
    const defaultLimit =
      rawLimit === null || rawLimit === undefined ? DEFAULTS.defaultLimit : clampInt(rawLimit, 1, 100, 1);
    return {
      enabled: typeof stored.enabled === 'boolean' ? stored.enabled : DEFAULTS.enabled,
      defaultLimit,
      defaultAction: action,
      gracePeriodSeconds: clampInt(stored.gracePeriodSeconds, 0, 300, DEFAULTS.gracePeriodSeconds),
      countPaused: typeof stored.countPaused === 'boolean' ? stored.countPaused : DEFAULTS.countPaused,
      pausedExpirationMinutes: clampInt(stored.pausedExpirationMinutes, 0, 1440, DEFAULTS.pausedExpirationMinutes),
      scope,
    };
  }

  async update(patch: StreamControlSettingsPatch): Promise<StreamControlSettings> {
    const current = await this.read();
    const next: StreamControlSettings = { ...current };

    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    if ('defaultLimit' in patch) {
      next.defaultLimit = patch.defaultLimit === null || patch.defaultLimit === undefined
        ? null
        : clampInt(patch.defaultLimit, 1, 100, current.defaultLimit ?? 1);
    }
    if (patch.defaultAction && ENFORCEMENT_ACTIONS.includes(patch.defaultAction)) next.defaultAction = patch.defaultAction;
    if ('gracePeriodSeconds' in patch) next.gracePeriodSeconds = clampInt(patch.gracePeriodSeconds, 0, 300, current.gracePeriodSeconds);
    if (typeof patch.countPaused === 'boolean') next.countPaused = patch.countPaused;
    if ('pausedExpirationMinutes' in patch) next.pausedExpirationMinutes = clampInt(patch.pausedExpirationMinutes, 0, 1440, current.pausedExpirationMinutes);
    if (patch.scope && ENFORCEMENT_SCOPES.includes(patch.scope)) next.scope = patch.scope;

    await this.settings.set(STREAM_CONTROL_SETTINGS_KEY, next as unknown as Record<string, unknown>);
    return next;
  }
}
