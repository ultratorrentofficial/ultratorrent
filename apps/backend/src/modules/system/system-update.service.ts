import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { existsSync, readFileSync } from 'node:fs';
import { SettingsService } from '../settings/settings.module';

/** Settings key for the update-check toggle. */
const UPDATE_SETTINGS_KEY = 'system.updateCheck';
/** GitHub repo releases are tagged on (owner/name). Overridable for forks/mirrors. */
const DEFAULT_UPDATE_REPO = 'damirabal/ultratorrent-core';
/** Background check cadence — daily is plenty; GitHub allows 60 req/hr unauth. */
const CHECK_INTERVAL_MS = 24 * 60 * 60_000;

export type DeploymentKind = 'docker' | 'bare';

/** Client-facing update status. */
export interface UpdateStatus {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  deployment: DeploymentKind;
  checkEnabled: boolean;
  checkedAt: string | null;
  error: string | null;
  latestUrl: string | null;
  changelogUrl: string | null;
  /** Deployment-specific commands to apply the update (we never auto-apply). */
  updateSteps: string[];
}

/**
 * Checks GitHub for a newer UltraTorrent release and reports whether one is
 * available, along with the right way to apply it for this deployment.
 *
 * It never applies updates itself: in Docker the container can't replace the
 * image it runs from, and even bare-metal installs update by rebuilding a git
 * checkout — so we surface the exact command instead. The check is a single
 * read-only call to the GitHub tags API, cached and run at most daily (plus
 * on-demand), and can be disabled entirely.
 */
@Injectable()
export class SystemUpdateService implements OnModuleInit {
  private readonly logger = new Logger(SystemUpdateService.name);
  private readonly repo = process.env.ULTRATORRENT_UPDATE_REPO || DEFAULT_UPDATE_REPO;
  private readonly deployment: DeploymentKind = detectDeployment();

  private latest: string | null = null;
  private checkedAt: string | null = null;
  private error: string | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Prime the cache in the background if checks are enabled — never blocks boot.
    if (await this.isEnabled().catch(() => true)) {
      void this.refresh();
    }
  }

  @Interval('system_update_check', CHECK_INTERVAL_MS)
  async scheduledCheck(): Promise<void> {
    if (await this.isEnabled().catch(() => false)) {
      await this.refresh();
    }
  }

  async getStatus(): Promise<UpdateStatus> {
    const current = this.currentVersion();
    const checkEnabled = await this.isEnabled().catch(() => true);
    const latestParts = this.latest ? parseVersion(this.latest) : null;
    const currentParts = parseVersion(current);
    const updateAvailable = Boolean(
      latestParts && currentParts && compareParts(latestParts, currentParts) > 0,
    );
    const tag = this.latest ? `v${this.latest}` : null;
    return {
      current,
      latest: this.latest,
      updateAvailable,
      deployment: this.deployment,
      checkEnabled,
      checkedAt: this.checkedAt,
      error: this.error,
      latestUrl: tag ? `https://github.com/${this.repo}/releases/tag/${tag}` : null,
      changelogUrl: tag ? `https://github.com/${this.repo}/blob/${tag}/CHANGELOG.md` : null,
      updateSteps: this.updateSteps(),
    };
  }

  /** Force a fresh check now (user-initiated) and return the updated status. */
  async checkNow(): Promise<UpdateStatus> {
    await this.refresh();
    return this.getStatus();
  }

  /** Enable/disable the background update check; re-checks immediately when turned on. */
  async setEnabled(enabled: boolean): Promise<UpdateStatus> {
    await this.settings.set(UPDATE_SETTINGS_KEY, { enabled });
    if (enabled) void this.refresh();
    return this.getStatus();
  }

  // --- internals -----------------------------------------------------------

  private currentVersion(): string {
    return this.config.get<string>('node.productVersion') ?? '0.0.0';
  }

  private async isEnabled(): Promise<boolean> {
    const stored = await this.settings.get<{ enabled?: boolean }>(UPDATE_SETTINGS_KEY);
    return stored?.enabled ?? true; // on by default
  }

  private updateSteps(): string[] {
    if (this.deployment === 'docker') {
      return ['git pull', 'docker compose up -d --build'];
    }
    return [
      'git pull',
      'npm install',
      'npm run prisma:migrate',
      'npm run build',
      'Restart the UltraTorrent service',
    ];
  }

  /** One read-only call to the GitHub tags API; failures are recorded, not thrown. */
  private async refresh(): Promise<void> {
    const url = `https://api.github.com/repos/${this.repo}/tags?per_page=100`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'UltraTorrent-UpdateCheck',
          Accept: 'application/vnd.github+json',
        },
      });
      if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
      const tags = (await res.json()) as Array<{ name?: string }>;
      let best: number[] | null = null;
      let bestName: string | null = null;
      for (const tag of tags) {
        const parts = parseVersion(tag?.name ?? '');
        if (parts && (!best || compareParts(parts, best) > 0)) {
          best = parts;
          bestName = parts.join('.');
        }
      }
      this.latest = bestName;
      this.error = null;
    } catch (err) {
      this.error = (err as Error).message;
      this.logger.warn(`Update check failed: ${this.error}`);
    } finally {
      clearTimeout(timer);
      this.checkedAt = new Date().toISOString();
    }
  }
}

/** Detect Docker vs bare-metal so we can show the right update command. */
function detectDeployment(): DeploymentKind {
  const override = process.env.ULTRATORRENT_DEPLOYMENT?.toLowerCase();
  if (override === 'docker' || override === 'bare') return override;
  try {
    if (existsSync('/.dockerenv')) return 'docker';
  } catch {
    /* not fatal */
  }
  try {
    if (/docker|containerd|kubepods/i.test(readFileSync('/proc/1/cgroup', 'utf8'))) {
      return 'docker';
    }
  } catch {
    /* /proc unavailable — fall through */
  }
  return 'bare';
}

/** Parse `v1.2.3` / `1.2.3` into numeric parts; null if it isn't a release tag. */
function parseVersion(value: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareParts(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export { parseVersion, compareParts };
