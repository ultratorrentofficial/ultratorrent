import { Injectable, Logger } from '@nestjs/common';
import { XMLParser } from 'fast-xml-parser';
import Parser from 'rss-parser';

/** A configured indexer connection (apiKey already decrypted by the service). */
export interface IndexerConnection {
  id: string;
  name: string;
  implementation: string; // torznab | newznab
  baseUrl: string;
  apiKey: string;
  categories: number[];
  timeoutMs: number;
}

export interface TvSearchQuery {
  q: string;
  season?: number;
  ep?: number;
  categories?: number[];
}

/** A normalized release candidate returned by an indexer search. */
export interface IndexerCandidate {
  indexerId: string;
  indexerName: string;
  title: string;
  /** magnet: (preferred) or an http(s) .torrent URL; null when neither is present. */
  downloadUrl: string | null;
  infoHash: string | null;
  sizeBytes: number | null;
  seeders: number | null;
  categories: number[];
}

export interface IndexerCapabilities {
  server?: { title?: string };
  tvSearch: boolean;
  movieSearch: boolean;
  supportedParams: string[];
  categories: { id: number; name: string }[];
  limits?: { default?: number; max?: number };
}

const toArray = <T>(v: T | T[] | undefined | null): T[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];

/**
 * Torznab/Newznab client: capability negotiation + tv-search over HTTP, parsing
 * the RSS/XML response into normalized {@link IndexerCandidate}s. The API key is
 * injected into the `apikey=` query param — callers must never log the full URL.
 * Magnet/size/seeders come from `torznab:attr`/`newznab:attr` elements; a plain
 * `.torrent` enclosure works too (the download executor handles both).
 */
@Injectable()
export class TorznabClient {
  private readonly logger = new Logger(TorznabClient.name);
  private readonly caps = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  // Mirrors the RSS module's feed parser: expose the magnet/attr fields torznab
  // feeds carry beyond <link>/<enclosure>. Both namespaces normalize to `attrs`.
  private readonly rss = new Parser({
    timeout: 15000,
    customFields: {
      item: [
        ['torznab:attr', 'attrs', { keepArray: true }],
        ['newznab:attr', 'attrs', { keepArray: true }],
        ['torrent:magnetURI', 'torrentMagnet'],
        'magneturl',
        'magnetURI',
      ],
    },
  });

  /** Negotiate capabilities via `t=caps`. Tolerates missing sections. */
  async fetchCaps(conn: IndexerConnection): Promise<IndexerCapabilities> {
    const xml = await this.httpGet(this.buildUrl(conn, { t: 'caps' }), conn.timeoutMs, conn);
    const doc = this.caps.parse(xml);
    const caps = doc?.caps ?? {};
    const searching = caps.searching ?? {};
    const catNodes = toArray<any>(caps.categories?.category);
    const categories = catNodes
      .map((c) => ({ id: Number(c?.['@_id']), name: String(c?.['@_name'] ?? '') }))
      .filter((c) => Number.isFinite(c.id));
    const available = (node: any) => String(node?.['@_available'] ?? '').toLowerCase() === 'yes';
    const params = String(searching['tv-search']?.['@_supportedParams'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      server: caps.server ? { title: caps.server['@_title'] } : undefined,
      tvSearch: available(searching['tv-search']),
      movieSearch: available(searching['movie-search']),
      supportedParams: params,
      categories,
      limits: caps.limits
        ? { default: Number(caps.limits['@_default']) || undefined, max: Number(caps.limits['@_max']) || undefined }
        : undefined,
    };
  }

  /**
   * Search for episodes. Uses `t=tvsearch` with season/ep params; falls back to a
   * plain `t=search&q="Show SxxEyy"` when the caller opts out of tvsearch params.
   */
  async search(conn: IndexerConnection, query: TvSearchQuery, useTvSearch = true): Promise<IndexerCandidate[]> {
    const cats = (query.categories?.length ? query.categories : conn.categories) ?? [];
    const params: Record<string, string> = useTvSearch
      ? {
          t: 'tvsearch',
          q: query.q,
          ...(query.season != null ? { season: String(query.season) } : {}),
          ...(query.ep != null ? { ep: String(query.ep) } : {}),
        }
      : {
          t: 'search',
          q: this.plainQuery(query),
        };
    if (cats.length) params.cat = cats.join(',');
    const xml = await this.httpGet(this.buildUrl(conn, params), conn.timeoutMs, conn);
    const feed = await this.rss.parseString(this.normalizeRssVersion(xml));
    return (feed.items ?? []).map((item) => this.normalize(conn, item as any));
  }

  /**
   * Prowlarr and Jackett emit `<rss version="1.0">` for Torznab feeds, but
   * `rss-parser` only accepts `version="2.x"` (or a true RDF-based RSS 1) and
   * otherwise throws "Feed not recognized as RSS 1 or 2." Rewrite the version
   * attribute on the root `<rss>` element to `2.0` so these standard Torznab
   * servers parse — the same leniency Sonarr/Radarr apply. Non-RSS roots
   * (`<feed>` Atom) don't match and are left untouched.
   */
  private normalizeRssVersion(xml: string): string {
    return xml.replace(/(<rss\b[^>]*\bversion=["'])[^"']*(["'])/i, (_m, pre, quote) => `${pre}2.0${quote}`);
  }

  /** `Show S01E02` style query for indexers without tvsearch season/ep support. */
  private plainQuery(q: TvSearchQuery): string {
    if (q.season != null && q.ep != null) {
      const s = String(q.season).padStart(2, '0');
      const e = String(q.ep).padStart(2, '0');
      return `${q.q} S${s}E${e}`;
    }
    return q.q;
  }

  private normalize(conn: IndexerConnection, item: any): IndexerCandidate {
    const magnet = this.extractMagnet(item);
    const enclosure = typeof item?.enclosure?.url === 'string' ? item.enclosure.url : null;
    const link = typeof item?.link === 'string' && /^https?:/i.test(item.link) ? item.link : null;
    const downloadUrl = magnet ?? enclosure ?? link;
    const attrSize = Number(this.attr(item, 'size'));
    const enclosureLen = Number(item?.enclosure?.length);
    const sizeBytes = Number.isFinite(attrSize) && attrSize > 0
      ? attrSize
      : Number.isFinite(enclosureLen) && enclosureLen > 0
        ? enclosureLen
        : null;
    const seedersRaw = this.attr(item, 'seeders');
    const seeders = seedersRaw != null && seedersRaw !== '' && Number.isFinite(Number(seedersRaw))
      ? Number(seedersRaw)
      : null;
    const cats = toArray(item?.attrs)
      .filter((a: any) => (a?.$?.name ?? a?.name) === 'category')
      .map((a: any) => Number(a?.$?.value ?? a?.value))
      .filter((n) => Number.isFinite(n));
    return {
      indexerId: conn.id,
      indexerName: conn.name,
      title: String(item?.title ?? '').trim(),
      downloadUrl,
      infoHash: this.attr(item, 'infohash')?.toLowerCase() ?? this.infoHashFromMagnet(magnet),
      sizeBytes,
      seeders,
      categories: cats,
    };
  }

  /** Read a torznab/newznab `<attr name=.. value=..>` value (namespaces merged into `attrs`). */
  private attr(item: any, name: string): string | null {
    for (const a of toArray(item?.attrs)) {
      const n = a?.$?.name ?? a?.name;
      const v = a?.$?.value ?? a?.value;
      if (n === name && v != null) return String(v);
    }
    return null;
  }

  /** Magnet extraction mirroring RssService.extractMagnet (kept local to avoid importing RSS). */
  private extractMagnet(item: any): string | null {
    const isMagnet = (v: unknown): v is string => typeof v === 'string' && v.startsWith('magnet:');
    for (const v of [item?.enclosure?.url, item?.link, item?.guid]) if (isMagnet(v)) return v;
    const attrMagnet = this.attr(item, 'magneturl');
    if (isMagnet(attrMagnet)) return attrMagnet;
    for (const v of [item?.torrentMagnet, item?.['torrent:magnetURI'], item?.magneturl, item?.magnetURI, item?.magnet]) {
      if (isMagnet(v)) return v;
    }
    return null;
  }

  private infoHashFromMagnet(magnet: string | null): string | null {
    if (!magnet) return null;
    const m = /xt=urn:btih:([a-z0-9]+)/i.exec(magnet);
    return m ? m[1].toLowerCase() : null;
  }

  private buildUrl(conn: IndexerConnection, params: Record<string, string>): string {
    const base = conn.baseUrl.replace(/\/+$/, '');
    const endpoint = /\/api$/i.test(base) ? base : `${base}/api`;
    const url = new URL(endpoint);
    if (conn.apiKey) url.searchParams.set('apikey', conn.apiKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  }

  private async httpGet(url: string, timeoutMs: number, conn: IndexerConnection): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'UltraTorrent' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      // Never log the URL — it carries the apiKey. Reference the indexer by name.
      throw new Error(`Indexer "${conn.name}" request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
