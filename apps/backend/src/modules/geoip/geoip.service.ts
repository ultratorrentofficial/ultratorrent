import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { promises as fs, watch as fsWatch, type FSWatcher } from 'node:fs';
import type { Reader, CityResponse, AsnResponse } from 'maxmind';

/** One resolved location, flattened to what a card actually shows. */
export interface GeoLocation {
  /** ISO-3166 alpha-2, uppercased — drives the flag. Null when the DB has none. */
  countryCode: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
}

/**
 * How a single IP resolved. `kind` is the honest three-way answer a UI needs:
 *
 *  - `private` — a LAN/loopback address the viewer reached the server on
 *    directly. There is no public geography to look up; it is shown as "Local".
 *  - `public` — a routable address that WAS looked up. `location` may still be
 *    null field-by-field if the database knows the country but not the city.
 *  - `unknown` — a public address the database could not place at all, or the
 *    database is not loaded. The IP is real; its geography is simply unavailable.
 */
export interface GeoResult {
  ip: string;
  kind: 'private' | 'public' | 'unknown';
  location: GeoLocation | null;
  /** Autonomous-system org (the ISP/network), from the ASN database. Null when
   * unavailable — that database is optional and separate from the city one. */
  isp: string | null;
  /** The autonomous-system number, when known. */
  asn: number | null;
}

/**
 * Offline IP geolocation against a MaxMind GeoLite2-City database.
 *
 * The database is a file the operator provisions (a free MaxMind licence is
 * required to download it); nothing here calls out to a network, so a viewer's
 * IP address never leaves the host. The path is `GEOIP_DB_PATH`.
 *
 * Everything degrades to "unknown" rather than throwing: no file, an unreadable
 * or corrupt file, or a lookup miss all return a result the caller can render.
 * A media server that cannot geolocate is not a broken media server.
 */
@Injectable()
export class GeoIpService implements OnModuleDestroy {
  private readonly logger = new Logger(GeoIpService.name);
  private readonly dbPath = process.env.GEOIP_DB_PATH?.trim() || '/data/geoip/GeoLite2-City.mmdb';
  private reader: Reader<CityResponse> | null = null;
  private loadedMtimeMs = 0;
  private loading: Promise<void> | null = null;
  private watcher: FSWatcher | null = null;

  private readonly asnPath = process.env.GEOIP_ASN_DB_PATH?.trim() || '/data/geoip/GeoLite2-ASN.mmdb';
  private asnReader: Reader<AsnResponse> | null = null;
  private asnLoadedMtimeMs = 0;
  private asnLoading: Promise<void> | null = null;

  /** True when a database is loaded and lookups will be attempted. */
  get available(): boolean {
    return this.reader !== null;
  }

  /**
   * Resolve one address. Private and malformed addresses never touch the reader.
   * Safe to call before the database exists — it simply returns `unknown`.
   */
  async lookup(ip: string | null | undefined): Promise<GeoResult> {
    const addr = (ip ?? '').trim();
    if (!addr) return { ip: '', kind: 'unknown', location: null, isp: null, asn: null };
    if (isPrivateAddress(addr)) return { ip: addr, kind: 'private', location: null, isp: null, asn: null };

    await this.ensureLoaded();
    await this.ensureAsnLoaded();
    if (!this.reader && !this.asnReader) return { ip: addr, kind: 'unknown', location: null, isp: null, asn: null };

    const { isp, asn } = this.lookupAsn(addr);
    try {
      const hit = this.reader?.get(addr) ?? null;
      const location = hit ? flatten(hit) : null;
      // A public address with no usable fields is still "public but unplaced".
      return {
        ip: addr,
        kind: 'public',
        location: location && hasAnyField(location) ? location : null,
        isp,
        asn,
      };
    } catch (err) {
      // A malformed address the private-check let through, or a reader fault.
      this.logger.debug(`geoip lookup failed for ${addr}: ${(err as Error).message}`);
      return { ip: addr, kind: 'unknown', location: null, isp, asn };
    }
  }

  /** Best-effort ASN/org for an address; both null when the ASN db is absent. */
  private lookupAsn(addr: string): { isp: string | null; asn: number | null } {
    if (!this.asnReader) return { isp: null, asn: null };
    try {
      const hit = this.asnReader.get(addr);
      return {
        isp: hit?.autonomous_system_organization ?? null,
        asn: hit?.autonomous_system_number ?? null,
      };
    } catch {
      return { isp: null, asn: null };
    }
  }

  private async ensureAsnLoaded(): Promise<void> {
    if (this.asnLoading) return this.asnLoading;
    this.asnLoading = this.loadAsn().finally(() => {
      this.asnLoading = null;
    });
    return this.asnLoading;
  }

  private async loadAsn(): Promise<void> {
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(this.asnPath)).mtimeMs;
    } catch {
      this.asnReader = null;
      return;
    }
    if (this.asnReader && mtimeMs === this.asnLoadedMtimeMs) return;
    try {
      const { open } = await import('maxmind');
      this.asnReader = await open<AsnResponse>(this.asnPath);
      this.asnLoadedMtimeMs = mtimeMs;
      this.logger.log(`GeoIP ASN database loaded from ${this.asnPath}`);
    } catch (err) {
      this.asnReader = null;
      this.logger.warn(`GeoIP ASN database at ${this.asnPath} could not be read: ${(err as Error).message}`);
    }
  }

  /** Resolve many at once, de-duplicating so a page of one viewer is one lookup. */
  async lookupMany(ips: ReadonlyArray<string | null | undefined>): Promise<Map<string, GeoResult>> {
    const out = new Map<string, GeoResult>();
    const unique = new Set<string>();
    for (const ip of ips) {
      const addr = (ip ?? '').trim();
      if (addr) unique.add(addr);
    }
    for (const addr of unique) out.set(addr, await this.lookup(addr));
    return out;
  }

  /**
   * Load the database on first use and reload it when the file is replaced —
   * the operator refreshes GeoLite2 monthly, and a long-running server should
   * pick that up without a restart. `maxmind.open` is dynamically imported so a
   * deployment that never geolocates pays nothing for the reader.
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async load(): Promise<void> {
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(this.dbPath)).mtimeMs;
    } catch {
      if (this.reader) this.logger.warn(`GeoIP database disappeared at ${this.dbPath}`);
      this.reader = null;
      return;
    }
    if (this.reader && mtimeMs === this.loadedMtimeMs) return; // already current

    try {
      const { open } = await import('maxmind');
      this.reader = await open<CityResponse>(this.dbPath);
      this.loadedMtimeMs = mtimeMs;
      this.armWatcher();
      this.logger.log(`GeoIP database loaded from ${this.dbPath}`);
    } catch (err) {
      this.reader = null;
      this.logger.warn(`GeoIP database at ${this.dbPath} could not be read: ${(err as Error).message}`);
    }
  }

  /** Reload on the next lookup after the file changes; best-effort. */
  private armWatcher(): void {
    if (this.watcher) return;
    try {
      this.watcher = fsWatch(this.dbPath, () => {
        // Do not reload inside the event: just invalidate so the next lookup reloads.
        this.loadedMtimeMs = 0;
      });
    } catch {
      /* watching is a nicety; polling by mtime on load already covers refreshes */
    }
  }

  onModuleDestroy(): void {
    this.watcher?.close();
    this.watcher = null;
  }
}

/** Flatten a MaxMind response to the fields a card renders. */
function flatten(hit: CityResponse): GeoLocation {
  return {
    countryCode: hit.country?.iso_code?.toUpperCase() ?? null,
    country: hit.country?.names?.en ?? null,
    region: hit.subdivisions?.[0]?.names?.en ?? null,
    city: hit.city?.names?.en ?? null,
    latitude: hit.location?.latitude ?? null,
    longitude: hit.location?.longitude ?? null,
  };
}

function hasAnyField(loc: GeoLocation): boolean {
  return Boolean(loc.countryCode || loc.country || loc.region || loc.city);
}

/**
 * Private, loopback, link-local, CGNAT and unique-local addresses — everything
 * that is not routable on the public internet and therefore has no geography.
 *
 * Deliberately broad: 100.64/10 (carrier-grade NAT) and IPv6 fc00::/7 (ULA) are
 * as local as 192.168 for this purpose. An IPv4-mapped IPv6 (`::ffff:a.b.c.d`)
 * is unwrapped first so the v4 rules apply to it.
 */
export function isPrivateAddress(ip: string): boolean {
  let addr = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped) addr = mapped[1];

  if (addr.includes('.')) {
    const parts = addr.split('.').map((p) => Number.parseInt(p, 10));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b] = parts;
    if (a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a === 0) return true;
    return false;
  }

  // IPv6
  if (addr === '::1' || addr === '::') return true;
  if (addr.startsWith('fe80')) return true; // link-local
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // unique-local fc00::/7
  return false;
}
