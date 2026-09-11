import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import * as path from 'node:path';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.module';
import { GeoIpService, type GeoDbInfo } from './geoip.service';
import { GeoIpSettingsService, type GeoIpEdition } from './geoip-settings.service';

/** Minimal audit context — who asked, from where. */
export interface GeoIpAuditContext {
  userId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Where MaxMind serves the databases. Fixed host — never operator-supplied. */
const DOWNLOAD_HOST = 'https://download.maxmind.com';
/** A large-but-bounded ceiling so a wrong URL cannot stream forever. */
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** Persisted summary of the last run, for the status screen. */
const STATE_KEY = 'geoip.state';

export interface EditionResult {
  edition: GeoIpEdition;
  ok: boolean;
  bytes?: number;
  buildEpoch?: number | null;
  error?: string;
}

export interface GeoIpUpdateResult {
  ranAt: string;
  editions: EditionResult[];
  ok: boolean;
}

export interface GeoIpStatus {
  configured: boolean;
  autoUpdate: boolean;
  updateIntervalHours: number;
  editions: GeoIpEdition[];
  databases: { city: GeoDbInfo; asn: GeoDbInfo };
  lastRun: GeoIpUpdateResult | null;
  /** True while a download is in progress, so the UI can disable the button. */
  updating: boolean;
}

/**
 * Downloads and installs the MaxMind GeoLite2 databases, the way the IMDb
 * dataset importer fetches its `.tsv.gz` files — a first-party, admin-triggered
 * pull from a fixed, sanctioned host, using the operator's own MaxMind licence.
 *
 * This is the ONLY outbound call in the geolocation feature, and it fetches a
 * public database — no viewer IP is ever sent anywhere. Lookups stay entirely
 * offline. The archive is fetched, its checksum verified, the `.mmdb` extracted
 * and written atomically to exactly where `GeoIpService` reads, and the reader
 * invalidated so the refresh is live on the next lookup.
 */
@Injectable()
export class GeoIpDownloaderService {
  private readonly logger = new Logger(GeoIpDownloaderService.name);
  private updating = false;

  constructor(
    private readonly settings: GeoIpSettingsService,
    private readonly geoip: GeoIpService,
    private readonly store: SettingsService,
    private readonly audit: AuditService,
  ) {}

  get isUpdating(): boolean {
    return this.updating;
  }

  async status(): Promise<GeoIpStatus> {
    const [cfg, databases, lastRun] = await Promise.all([
      this.settings.read(),
      this.geoip.databaseInfo(),
      this.store.get<GeoIpUpdateResult>(STATE_KEY),
    ]);
    return {
      configured: Boolean(cfg.accountId && cfg.licenseKey),
      autoUpdate: cfg.autoUpdate,
      updateIntervalHours: cfg.updateIntervalHours,
      editions: cfg.editions,
      databases,
      lastRun: lastRun ?? null,
      updating: this.updating,
    };
  }

  /**
   * Refresh every configured edition. Serialized — a second caller (a manual
   * click landing during the scheduled run) is refused rather than racing to
   * write the same files.
   */
  async updateNow(ctx: GeoIpAuditContext = {}): Promise<GeoIpUpdateResult> {
    const cfg = await this.settings.read();
    if (!cfg.accountId || !cfg.licenseKey) {
      throw new Error('MaxMind account id and licence key are required before downloading.');
    }
    if (this.updating) {
      throw new Error('A GeoIP database update is already in progress.');
    }
    this.updating = true;
    await this.audit.record({
      userId: ctx.userId ?? undefined,
      action: 'geoip.database.update.started',
      objectType: 'geoip',
      objectId: undefined,
      ipAddress: ctx.ipAddress ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
      metadata: { editions: cfg.editions },
    });

    const editions: EditionResult[] = [];
    try {
      for (const edition of cfg.editions) {
        try {
          const { bytes, buildEpoch } = await this.installEdition(edition, cfg.accountId, cfg.licenseKey);
          editions.push({ edition, ok: true, bytes, buildEpoch });
        } catch (err) {
          this.logger.warn(`GeoIP ${edition} update failed: ${(err as Error).message}`);
          editions.push({ edition, ok: false, error: (err as Error).message });
        }
      }
    } finally {
      this.updating = false;
    }

    // A fresh file was written; drop the cached readers so the next lookup uses it.
    if (editions.some((e) => e.ok)) this.geoip.invalidate();

    const result: GeoIpUpdateResult = {
      ranAt: new Date().toISOString(),
      editions,
      ok: editions.length > 0 && editions.every((e) => e.ok),
    };
    await this.store.set(STATE_KEY, result);
    await this.audit.record({
      userId: ctx.userId ?? undefined,
      action: result.ok ? 'geoip.database.update.completed' : 'geoip.database.update.failed',
      objectType: 'geoip',
      objectId: undefined,
      ipAddress: ctx.ipAddress ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
      metadata: { editions: editions.map((e) => ({ edition: e.edition, ok: e.ok })) },
    });
    return result;
  }

  /** Download one edition, verify it, and install its `.mmdb`. */
  private async installEdition(
    edition: GeoIpEdition,
    accountId: string,
    licenseKey: string,
  ): Promise<{ bytes: number; buildEpoch: number | null }> {
    const auth = 'Basic ' + Buffer.from(`${accountId}:${licenseKey}`).toString('base64');
    const base = `${DOWNLOAD_HOST}/geoip/databases/${encodeURIComponent(edition)}/download`;

    const archive = await this.fetchBounded(`${base}?suffix=tar.gz`, auth);
    const expected = await this.fetchChecksum(`${base}?suffix=tar.gz.sha256`, auth);
    if (expected) {
      const actual = createHash('sha256').update(archive).digest('hex');
      if (actual !== expected) {
        throw new Error(`checksum mismatch for ${edition} (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
      }
    }

    const mmdb = extractMmdb(gunzipSync(archive));
    if (!mmdb) throw new Error(`no .mmdb found inside the ${edition} archive`);

    const dest = this.targetPath(edition);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, mmdb);
    await fs.rename(tmp, dest); // atomic replace on the same filesystem

    const buildEpoch = readBuildEpochFromName(mmdb);
    this.logger.log(`GeoIP ${edition} installed (${mmdb.length} bytes) → ${dest}`);
    return { bytes: mmdb.length, buildEpoch };
  }

  /** The path GeoIpService reads for this edition — one source of truth. */
  private targetPath(edition: GeoIpEdition): string {
    return edition === 'GeoLite2-ASN' ? this.geoip.asnDbPath : this.geoip.cityDbPath;
  }

  private async fetchBounded(url: string, auth: string): Promise<Buffer> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { Authorization: auth }, signal: ctrl.signal });
      if (!res.ok) {
        const detail = res.status === 401 ? ' (check the account id and licence key)' : '';
        throw new Error(`HTTP ${res.status} from MaxMind${detail}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_ARCHIVE_BYTES) throw new Error('archive larger than the safety ceiling');
      return buf;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The sha256 sidecar is a short text line: `<hex>  <filename>`. Best-effort. */
  private async fetchChecksum(url: string, auth: string): Promise<string | null> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30_000);
      try {
        const res = await fetch(url, { headers: { Authorization: auth }, signal: ctrl.signal });
        if (!res.ok) return null;
        const text = (await res.text()).trim();
        const hex = text.split(/\s+/)[0];
        return /^[0-9a-f]{64}$/i.test(hex) ? hex.toLowerCase() : null;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return null; // a missing checksum must not block an otherwise-good download
    }
  }
}

/**
 * Extract the single `.mmdb` member from a (already gunzipped) tar archive.
 *
 * A deliberately minimal reader: tar is 512-byte blocks, each file preceded by a
 * header whose name is at offset 0 (100 bytes) and octal size at offset 124 (12
 * bytes). We never write using a name FROM the archive — we scan for the one
 * entry whose name ends in `.mmdb` and return its bytes — so there is no
 * path-traversal surface, unlike a general extractor.
 */
export function extractMmdb(tar: Buffer): Buffer | null {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    // Two consecutive zero blocks mark the end of the archive.
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeOctal, 8);
    if (!Number.isFinite(size) || size < 0) break;
    const dataStart = offset + 512;
    if (name.endsWith('.mmdb')) {
      if (dataStart + size > tar.length) return null;
      return Buffer.from(tar.subarray(dataStart, dataStart + size));
    }
    // Advance past this entry's data, rounded up to the next 512-byte block.
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

/**
 * MaxMind names the archive directory `GeoLite2-City_YYYYMMDD`, but that name is
 * gone by the time we hold only the `.mmdb`. The build date lives in the mmdb
 * metadata; reading it fully needs the reader, so callers who want it use
 * `GeoIpService.databaseInfo()`. This returns null — the field is populated from
 * the installed file's metadata, not guessed here.
 */
function readBuildEpochFromName(_mmdb: Buffer): number | null {
  return null;
}
