import { BadRequestException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Cloud instance-metadata endpoints. A Prowlarr URL never legitimately points
 * here, and letting one through would be a classic SSRF credential-exfil vector,
 * so we block these outright even though private/docker hosts are allowed.
 */
const METADATA_ADDRESSES = new Set(['169.254.169.254', 'fd00:ec2::254']);

/**
 * Validate an operator-supplied Prowlarr URL.
 *
 * This is deliberately looser than the general {@link isBlockedAddress} SSRF
 * guard: a Prowlarr companion normally lives on a **private** address
 * (`http://prowlarr:9696` on the docker network), so private ranges are
 * ALLOWED — that is the intended target. We still enforce an http(s) scheme and
 * forbid embedded credentials (which could smuggle secrets or confuse the
 * target). DNS-based metadata blocking is applied separately at fetch time via
 * {@link assertNotMetadata}, since a hostname's resolution can change.
 */
export function parseProwlarrUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new BadRequestException('Invalid Prowlarr URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BadRequestException('Prowlarr URL must use http or https');
  }
  if (url.username || url.password) {
    throw new BadRequestException('Prowlarr URL must not contain credentials');
  }
  return url;
}

export function isMetadataAddress(ip: string): boolean {
  return METADATA_ADDRESSES.has(ip.toLowerCase());
}

/**
 * Resolve the URL's host and reject cloud-metadata endpoints. Applied right
 * before an outbound call so a DNS-rebind to the metadata IP can't slip through.
 * Resolution failures are ignored here (the fetch itself will surface an
 * unreachable-host error) so a transient DNS blip doesn't mask the real cause.
 */
export async function assertNotMetadata(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  for (const ip of addresses) {
    if (isMetadataAddress(ip)) {
      throw new BadRequestException('Prowlarr URL resolves to a blocked address');
    }
  }
}
