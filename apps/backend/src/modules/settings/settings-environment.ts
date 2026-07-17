/**
 * Read-only catalog of the environment / infrastructure settings, for the
 * Settings hub's "Infrastructure" section. These live in the deployment
 * environment (`.env` / container config), are read at boot, and are NOT editable
 * from the UI: several only apply after a restart, and the secrets among them
 * (DB password, JWT/encryption keys) must never be exposed or changed at runtime.
 * This surfaces WHAT they are and whether they are set, so an operator can find
 * and understand them — without leaking the values.
 */

export interface EnvSettingDef {
  key: string;
  group: string;
  label: string;
  description: string;
  /** True → the value is never returned; the UI shows only "set / not set". */
  secret: boolean;
}

export const ENVIRONMENT_CATALOG: EnvSettingDef[] = [
  // Runtime
  { key: 'NODE_ENV', group: 'Runtime', label: 'Environment', description: 'production or development; controls logging verbosity, secret-strength checks, and other safety gates.', secret: false },
  { key: 'PORT', group: 'Runtime', label: 'Backend port', description: 'TCP port the API listens on inside its container/host.', secret: false },
  { key: 'FRONTEND_PORT', group: 'Runtime', label: 'Frontend port', description: 'Port the web UI is served on.', secret: false },
  { key: 'CORS_ORIGIN', group: 'Runtime', label: 'CORS origin', description: 'Allowed browser origin(s) for API requests.', secret: false },
  { key: 'PRODUCT_NAME', group: 'Runtime', label: 'Product name', description: 'Display name shown in the UI chrome.', secret: false },

  // Database & cache
  { key: 'DATABASE_URL', group: 'Database & cache', label: 'Database URL', description: 'PostgreSQL connection string (contains the DB password).', secret: true },
  { key: 'POSTGRES_USER', group: 'Database & cache', label: 'Postgres user', description: 'Database user name.', secret: false },
  { key: 'POSTGRES_DB', group: 'Database & cache', label: 'Postgres database', description: 'Database name.', secret: false },
  { key: 'POSTGRES_PASSWORD', group: 'Database & cache', label: 'Postgres password', description: 'Database password.', secret: true },
  { key: 'REDIS_HOST', group: 'Database & cache', label: 'Redis host', description: 'Redis hostname.', secret: false },
  { key: 'REDIS_PORT', group: 'Database & cache', label: 'Redis port', description: 'Redis port.', secret: false },

  // Security (all read-only + secret; changing these requires a redeploy and can lock out sessions)
  { key: 'JWT_ACCESS_SECRET', group: 'Security', label: 'JWT access secret', description: 'Signs short-lived access tokens. Rotating it invalidates active sessions.', secret: true },
  { key: 'JWT_REFRESH_SECRET', group: 'Security', label: 'JWT refresh secret', description: 'Signs refresh tokens.', secret: true },
  { key: 'ENCRYPTION_KEY', group: 'Security', label: 'Encryption key', description: 'AES-256-GCM key for secrets at rest (provider keys, TOTP seeds). Rotating it makes existing encrypted values unreadable.', secret: true },
  { key: 'JWT_ACCESS_TTL', group: 'Security', label: 'Access token TTL', description: 'How long an access token is valid (e.g. 15m).', secret: false },
  { key: 'JWT_REFRESH_TTL_DAYS', group: 'Security', label: 'Refresh token TTL (days)', description: 'How long a refresh token is valid.', secret: false },

  // Storage & files
  { key: 'FILE_MANAGER_ROOTS', group: 'Storage & files', label: 'Storage roots', description: 'Comma-separated hard boundary for ALL filesystem access (downloads, media, sidecars). The security sandbox — deliberately not editable in-app.', secret: false },

  // Engines & integrations
  { key: 'RTORRENT_SCGI_HOST', group: 'Engines & integrations', label: 'rTorrent SCGI host', description: 'Host of the rTorrent SCGI control socket.', secret: false },
  { key: 'RTORRENT_SCGI_PORT', group: 'Engines & integrations', label: 'rTorrent SCGI port', description: 'Port of the rTorrent SCGI socket.', secret: false },
  { key: 'QBITTORRENT_PORT', group: 'Engines & integrations', label: 'qBittorrent port', description: 'Port of the bundled qBittorrent WebUI.', secret: false },
  { key: 'PROWLARR_ENABLED', group: 'Engines & integrations', label: 'Prowlarr enabled', description: 'Whether the Prowlarr indexer companion is on.', secret: false },
  { key: 'PROWLARR_BASE_URL', group: 'Engines & integrations', label: 'Prowlarr base URL', description: 'Internal URL the backend reaches Prowlarr at.', secret: false },
  { key: 'TMDB_API_KEY', group: 'Engines & integrations', label: 'TMDB API key (env fallback)', description: 'Env fallback for the TMDB key when not set in Media Settings.', secret: true },
  { key: 'OMDB_API_KEY', group: 'Engines & integrations', label: 'OMDb API key (env fallback)', description: 'Env fallback for the OMDb key.', secret: true },

  // Seed admin (only used on first boot)
  { key: 'ADMIN_USERNAME', group: 'Seed admin', label: 'Seed admin username', description: 'Username created on first boot if no users exist.', secret: false },
  { key: 'ADMIN_EMAIL', group: 'Seed admin', label: 'Seed admin email', description: 'Email for the seed admin.', secret: false },
  { key: 'ADMIN_PASSWORD', group: 'Seed admin', label: 'Seed admin password', description: 'Initial password (only used on first boot).', secret: true },
];

export interface EnvSettingValue extends EnvSettingDef {
  set: boolean;
  /** The value for non-secrets; always null for secrets. */
  value: string | null;
}

/** Resolve the catalog against a process environment. Secrets never carry a value. Pure. */
export function readEnvironment(env: NodeJS.ProcessEnv): EnvSettingValue[] {
  return ENVIRONMENT_CATALOG.map((def) => {
    const raw = env[def.key];
    return { ...def, set: raw !== undefined && raw !== '', value: def.secret ? null : (raw ?? null) };
  });
}
