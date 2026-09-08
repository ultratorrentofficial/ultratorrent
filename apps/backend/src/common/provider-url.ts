import { BadRequestException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Outbound URLs for **operator-configured provider endpoints**.
 *
 * # The trust model, stated plainly
 *
 * UltraTorrent is self-hosted, and almost every provider it talks to lives on a
 * private address: `http://qbittorrent:8080` on a Docker network,
 * `http://192.168.1.20:9696` on a LAN, `http://127.0.0.1:32400` on the same box.
 * A general SSRF guard that blocks loopback and RFC1918 would block the product's
 * normal configuration, so this module deliberately **allows** them.
 *
 * What makes that safe is WHERE the URL comes from. These endpoints are set by an
 * authenticated administrator holding the relevant `manage_*` permission and are
 * persisted as configuration. That is a different thing from a URL arriving in a
 * request parameter, and the two must not share a policy:
 *
 * - **Configured provider endpoint** (this module) — private addresses allowed,
 *   because reaching the operator's own services is the entire purpose.
 * - **Request-time or third-party URL** (`common/ssrf.ts`) — private addresses
 *   blocked, because the destination is chosen by something we do not trust:
 *   a remote `.torrent` link, an artwork URL from a metadata provider, a
 *   newsletter image.
 *
 * Do not use this module for the second case, and do not relax `ssrf.ts` to
 * behave like this one.
 *
 * # What is still enforced
 *
 * Allowing private hosts is not the same as allowing anything:
 *
 * - **http/https only.** Other schemes are either meaningless to `fetch` or are
 *   a way to reach something that is not an HTTP service at all.
 * - **No embedded credentials.** A `user:pass@host` URL forwards a secret on
 *   every request and reads as a different host to a human than to a parser.
 * - **Cloud instance metadata is refused**, resolved at call time. No provider
 *   legitimately lives at 169.254.169.254, and reaching it is the classic route
 *   from "can make a request" to "has the deployment's credentials".
 *
 * Metadata resolution happens per call rather than once at save time, because a
 * hostname's answer can change between the two (DNS rebinding).
 */

/** Cloud instance-metadata endpoints. No provider is ever legitimately here. */
const METADATA_ADDRESSES = new Set(['169.254.169.254', 'fd00:ec2::254']);

export function isMetadataAddress(ip: string): boolean {
  return METADATA_ADDRESSES.has(ip.toLowerCase());
}

/**
 * Validate an operator-supplied provider base URL.
 *
 * `label` names the provider in the error, so a mistyped URL says which field is
 * wrong rather than producing a generic failure.
 */
export function parseProviderBaseUrl(raw: string, label: string): URL {
  const trimmed = String(raw ?? '').trim();

  /*
   * A scheme-less endpoint is normalised, not rejected.
   *
   * Operators really do configure `192.168.1.5:8080` — `normalizeBaseUrl` in the
   * analytics importer exists for exactly that, after a scheme-less value made
   * `fetch` throw "Failed to parse URL" on a live install. Rejecting it here
   * would turn a working configuration into a hard error on upgrade, which is
   * not a security improvement; it is an outage.
   *
   * `http://` is assumed because these are LAN services. The prefix is added only
   * when there is no `scheme://` and no protocol-relative `//`, so `//evil.test`
   * is left to fail validation rather than being quietly rebuilt into a host.
   *
   * The test requires the `//` deliberately: `qbittorrent:8080` is a host and a
   * port to a person and a SCHEME to a URL parser, and a rule that only looked
   * for a colon would reject the most common Docker configuration there is.
   * Prefixing does not smuggle anything past the scheme check — `javascript:x`
   * becomes `http://javascript:x`, whose port is not numeric, so it still fails.
   */
  const candidate =
    trimmed && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !trimmed.startsWith('//')
      ? `http://${trimmed}`
      : trimmed;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new BadRequestException(`Invalid ${label} URL`);
  }
  if (!url.hostname) {
    throw new BadRequestException(`Invalid ${label} URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BadRequestException(`${label} URL must use http or https`);
  }
  if (url.username || url.password) {
    throw new BadRequestException(`${label} URL must not contain credentials`);
  }
  return url;
}

/**
 * Resolve the host and refuse cloud metadata, immediately before an outbound call.
 *
 * A resolution failure is ignored on purpose: the fetch that follows will report
 * an unreachable host, which is the useful error. Turning a transient DNS blip
 * into "blocked address" would send operators looking for a security problem
 * that is not there.
 */
export async function assertNotMetadata(url: URL, label: string): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  for (const ip of addresses) {
    if (isMetadataAddress(ip)) {
      throw new BadRequestException(`${label} URL resolves to a blocked address`);
    }
  }
}

/**
 * Join a fixed API path onto a validated base, without letting the path move the
 * request somewhere else.
 *
 * String concatenation is what these call sites did, and it is *nearly* fine:
 * appending to `http://host:8080` cannot change the origin. It stops being fine
 * the moment a caller passes a path built from data — `//evil.example/x` is a
 * protocol-relative URL, and `new URL('//evil.example/x', base)` resolves to
 * `http://evil.example/x`. This joins on the path component only, so scheme,
 * host and port always come from the base and nothing in `path` can replace them.
 *
 * The base's own path is preserved, so a provider behind a reverse-proxy subpath
 * (`https://nas.example/prowlarr`) keeps working.
 */
export function joinProviderUrl(base: URL | string, path: string): string {
  const url = typeof base === 'string' ? new URL(base) : new URL(base.toString());
  const basePath = url.pathname.replace(/\/+$/, '');
  const suffix = String(path ?? '');
  const rel = suffix.startsWith('/') ? suffix : `/${suffix}`;

  // Split a query/fragment off the caller's path so they survive the join rather
  // than being escaped into the pathname.
  const hashAt = rel.indexOf('#');
  const withoutHash = hashAt === -1 ? rel : rel.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : rel.slice(hashAt);
  const qAt = withoutHash.indexOf('?');
  const pathOnly = qAt === -1 ? withoutHash : withoutHash.slice(0, qAt);
  const query = qAt === -1 ? '' : withoutHash.slice(qAt);

  const out = new URL(url.toString());
  out.pathname = `${basePath}${pathOnly}`;
  out.search = query;
  out.hash = hash;
  return out.toString();
}
