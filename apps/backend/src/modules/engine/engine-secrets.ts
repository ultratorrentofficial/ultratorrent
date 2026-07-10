import { SecretCipher } from '../../common/crypto/secret-cipher';

/**
 * Encrypt/redact helpers for the freeform `TorrentEngine.config` JSON. Secret
 * fields (currently the qBittorrent `password`) are AES-256-GCM encrypted at
 * rest and the encrypted field names recorded under `__encrypted` — the same
 * convention the Prowlarr/Indexer integrations use.
 */
export const ENGINE_SECRET_KEYS = ['password'] as const;

export type EngineConfig = Record<string, unknown>;

/** Encrypt every known-secret field; record which were encrypted. */
export function encryptEngineConfig(
  cipher: SecretCipher,
  config: EngineConfig,
): EngineConfig {
  const out: EngineConfig = {};
  const encrypted: string[] = [];
  for (const [k, v] of Object.entries(config ?? {})) {
    if (k === '__encrypted') continue;
    if (
      (ENGINE_SECRET_KEYS as readonly string[]).includes(k) &&
      typeof v === 'string' &&
      v
    ) {
      out[k] = cipher.encrypt(v);
      encrypted.push(k);
    } else {
      out[k] = v;
    }
  }
  if (encrypted.length) out.__encrypted = encrypted;
  return out;
}

/** Decrypt the recorded secret fields; a rotated/corrupt key fails that field closed. */
export function decryptEngineConfig(
  cipher: SecretCipher,
  stored: EngineConfig,
): EngineConfig {
  const encFields = new Set((stored?.__encrypted as string[]) ?? []);
  const out: EngineConfig = {};
  for (const [k, v] of Object.entries(stored ?? {})) {
    if (k === '__encrypted') continue;
    if (encFields.has(k) && typeof v === 'string') {
      try {
        out[k] = cipher.decrypt(v);
      } catch {
        out[k] = undefined; // key rotated/corrupt — never surface ciphertext
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** True when a secret field is present and encrypted (used to redact + to "keep existing"). */
export function hasEngineSecret(stored: EngineConfig, key: string): boolean {
  const encFields = new Set((stored?.__encrypted as string[]) ?? []);
  return encFields.has(key) && typeof stored?.[key] === 'string' && !!stored[key];
}
