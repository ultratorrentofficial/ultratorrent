import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resolve the product version: ULTRATORRENT_VERSION env (set in Docker via build
 * arg) → the root VERSION file (best-effort, searched up from cwd; works in dev)
 * → '0.10.0'. version.json/VERSION are the source of truth (see scripts/version.mjs).
 */
function resolveVersion(): string {
  if (process.env.ULTRATORRENT_VERSION) return process.env.ULTRATORRENT_VERSION;
  for (const rel of ['VERSION', '../VERSION', '../../VERSION', '../../../VERSION']) {
    try {
      const v = readFileSync(join(process.cwd(), rel), 'utf8').trim();
      if (v) return v;
    } catch {
      /* try next */
    }
  }
  return '0.10.0';
}

/** Parse an integer env var, clamped to [min, max], falling back to `def`. */
function intEnv(raw: string | undefined, def: number, min: number, max: number): number {
  const n = raw != null && raw.trim() !== '' ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export interface AppConfig {
  port: number;
  corsOrigin: string;
  jwt: {
    accessSecret: string;
    refreshSecret: string;
    accessTtl: string;
    refreshTtlDays: number;
  };
  redis: { host: string; port: number };
  fileManager: { roots: string[] };
  /**
   * IMDb optimized-import tuning. `minYear` is the default floor for the
   * "Optimized Movie Import" strategy (titles before it are skipped) and
   * `importBatchSize` the streaming insert/upsert batch size. Both are
   * overridable per-import via settings; these are the environment defaults.
   */
  imdb: { minYear: number; importBatchSize: number };
  encryptionKey: string;
  node: { productVersion: string; mode: string; publicUrl: string | null };
  edition: string;
}

/** Known-insecure development fallback secrets — must never run in production. */
export const INSECURE_SECRET_DEFAULTS = [
  'dev-access-secret-change-me',
  'dev-refresh-secret-change-me',
  'dev-encryption-key-change-me',
];

/**
 * Return a list of problems with the security-critical secrets. Empty = OK.
 * A production boot MUST refuse to start when this is non-empty (see
 * `bootstrap.ts`). Pure + exported for unit testing.
 */
export function findInsecureSecrets(secrets: {
  accessSecret: string;
  encryptionKey: string;
}): string[] {
  const problems: string[] = [];
  const check = (name: string, value: string) => {
    if (!value || INSECURE_SECRET_DEFAULTS.includes(value)) {
      problems.push(`${name} is unset or a known insecure default`);
    } else if (value.length < 32) {
      problems.push(`${name} is too short (use at least 32 random characters)`);
    }
  };
  check('JWT_ACCESS_SECRET', secrets.accessSecret);
  check('ENCRYPTION_KEY', secrets.encryptionKey);
  // The TOTP-at-rest key must be independent of the token-signing key.
  if (secrets.encryptionKey && secrets.encryptionKey === secrets.accessSecret) {
    problems.push('ENCRYPTION_KEY must be different from JWT_ACCESS_SECRET');
  }
  return problems;
}

export default (): AppConfig => ({
  port: parseInt(process.env.PORT ?? '4000', 10),
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET ?? 'dev-access-secret-change-me',
    refreshSecret:
      process.env.JWT_REFRESH_SECRET ?? 'dev-refresh-secret-change-me',
    accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    refreshTtlDays: parseInt(process.env.JWT_REFRESH_TTL_DAYS ?? '30', 10),
  },
  redis: {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  },
  fileManager: {
    roots: (process.env.FILE_MANAGER_ROOTS ?? '/downloads')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
  imdb: {
    minYear: intEnv(process.env.IMDB_MIN_YEAR, 1970, 1874, 2200),
    importBatchSize: intEnv(process.env.IMDB_IMPORT_BATCH_SIZE, 5000, 100, 100000),
  },
  // Used to encrypt TOTP secrets at rest. Falls back to the JWT secret in dev;
  // set a dedicated ENCRYPTION_KEY in production.
  encryptionKey:
    process.env.ENCRYPTION_KEY ??
    process.env.JWT_ACCESS_SECRET ??
    'dev-encryption-key-change-me',
  // Node Agent identity. `mode` defaults to standalone.
  node: {
    productVersion: resolveVersion(),
    mode: process.env.NODE_PRODUCT_MODE ?? 'standalone',
    publicUrl: process.env.NODE_PUBLIC_URL ?? null,
  },
  // Single-tier product: always the community edition.
  edition: 'community',
});
