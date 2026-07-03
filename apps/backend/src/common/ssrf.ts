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
  for (const ip of addresses) {
    if (isBlockedAddress(ip)) {
      throw new BadRequestException('Torrent URL resolves to a blocked internal address');
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
