import { BadRequestException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Default cap for a fetched .torrent (matches the upload limit). */
export const MAX_REMOTE_TORRENT_BYTES = 20 * 1024 * 1024;

function ipv4Blocked(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0 && p[2] === 0) return true; // 192.0.0.0/24
  if (a >= 224) return true; // multicast + reserved (224.0.0.0/3)
  return false;
}

function ipv6Blocked(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true; // loopback / unspecified
  if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb'))
    return true; // fe80::/10 link-local
  if (v.startsWith('fc') || v.startsWith('fd')) return true; // fc00::/7 unique-local
  if (v.startsWith('ff')) return true; // multicast
  // IPv4-mapped (::ffff:a.b.c.d) — validate the embedded v4.
  const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Blocked(mapped[1]);
  return false;
}

/** True if the address is loopback/private/link-local/metadata/multicast/reserved. */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return ipv4Blocked(ip);
  if (kind === 6) return ipv6Blocked(ip);
  return true; // not a valid IP → block
}

function ipv4ToInt(ip: string): number | null {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

/** IPv4 membership in a CIDR block (e.g. "192.168.99.10" ∈ "192.168.0.0/16"). */
function ipv4InCidr(ip: string, cidr: string): boolean {
  const [net, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const ipInt = ipv4ToInt(ip);
  const netInt = ipv4ToInt(net);
  if (ipInt === null || netInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  if (bits === 0) return true;
  const mask = (~((1 << (32 - bits)) - 1)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}

/**
 * Operator allowlist of trusted torrent hosts whose URLs may resolve to
 * otherwise-blocked private/internal addresses — e.g. a self-hosted Prowlarr /
 * Jackett on the LAN or Docker network that hands back `.torrent` proxy links.
 * Configured via the comma-separated `SSRF_ALLOW_HOSTS` env (hostnames, IPs, or
 * IPv4 CIDRs); empty by default, so the full SSRF protection is on unless the
 * operator explicitly trusts a host. This only relaxes the *private-address*
 * check — scheme allow-list, redirect refusal, and size caps still apply.
 */
export function isAllowlistedTorrentHost(hostname: string, resolvedIps: string[]): boolean {
  const entries = (process.env.SSRF_ALLOW_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) return false;
  const host = hostname.toLowerCase();
  for (const entry of entries) {
    if (entry.toLowerCase() === host) return true; // hostname match
    if (resolvedIps.includes(entry)) return true; // exact IP match
    if (entry.includes('/') && resolvedIps.some((ip) => isIP(ip) === 4 && ipv4InCidr(ip, entry))) {
      return true; // CIDR match
    }
  }
  return false;
}

/**
 * Assert an outbound URL is safe to fetch server-side, for any caller (webhooks,
 * artwork, provider images): http(s) only, and the host must not resolve to an
 * internal/loopback/link-local/metadata/private/multicast address — unless the
 * operator allow-listed it via `SSRF_ALLOW_HOSTS` (the same escape hatch used for a
 * LAN Prowlarr). Returns the parsed URL. Callers MUST still fetch with
 * `redirect: 'error'` so a 3xx can't bounce past this check to an internal target.
 * Throws {@link BadRequestException} on any violation.
 */
export async function assertSafeOutboundUrl(url: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BadRequestException('Invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequestException('Only http(s) URLs are allowed');
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.length === 0) throw new BadRequestException('Could not resolve URL host');
  if (!isAllowlistedTorrentHost(host, addresses)) {
    for (const ip of addresses) {
      if (isBlockedAddress(ip)) {
        throw new BadRequestException('URL resolves to a blocked internal address');
      }
    }
  }
  return parsed;
}

/**
 * SSRF-safe fetch of a remote .torrent. Rejects non-http(s) schemes, hosts that
 * resolve to internal/loopback/metadata addresses, redirects (which could bounce
 * to an internal target), and oversized bodies. Throws BadRequestException (400).
 */
export async function fetchRemoteTorrent(
  url: string,
  maxBytes = MAX_REMOTE_TORRENT_BYTES,
): Promise<Buffer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BadRequestException('Invalid torrent URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequestException('Only http(s) torrent URLs are allowed');
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.length === 0) {
    throw new BadRequestException('Could not resolve torrent URL host');
  }
  // A host the operator has explicitly trusted (SSRF_ALLOW_HOSTS) — e.g. a
  // self-hosted Prowlarr on the LAN — bypasses the private-address block.
  if (!isAllowlistedTorrentHost(host, addresses)) {
    for (const ip of addresses) {
      if (isBlockedAddress(ip)) {
        throw new BadRequestException('Torrent URL resolves to a blocked internal address');
      }
    }
  }

  const res = await fetch(url, {
    redirect: 'error', // do not follow redirects (could bounce to an internal host)
    signal: AbortSignal.timeout(15000),
  }).catch((err) => {
    throw new BadRequestException(`Could not fetch torrent URL: ${(err as Error).message}`);
  });
  if (!res.ok) throw new BadRequestException(`Failed to fetch torrent URL: ${res.status}`);

  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared && declared > maxBytes) {
    throw new BadRequestException('Torrent file is too large');
  }

  // Bounded streaming read so a Content-Length-less server can't stream forever.
  const reader = res.body?.getReader();
  if (!reader) {
    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxBytes) throw new BadRequestException('Torrent file is too large');
    return Buffer.from(ab);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BadRequestException('Torrent file is too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
