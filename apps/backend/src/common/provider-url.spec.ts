import { BadRequestException } from '@nestjs/common';
import {
  isMetadataAddress,
  joinProviderUrl,
  parseProviderBaseUrl,
} from './provider-url';

/**
 * The trust boundary for operator-configured provider endpoints.
 *
 * Half of these tests exist to stop a future "SSRF fix" from breaking the
 * product. UltraTorrent is self-hosted: its providers live on Docker networks,
 * LANs and loopback, and a guard that blocked those would be indistinguishable
 * from an outage for nearly every install. Those cases are asserted as loudly as
 * the attacks are.
 */
describe('a self-hosted provider endpoint is allowed', () => {
  it.each([
    ['http://qbittorrent:8080', 'docker service name'],
    ['http://prowlarr:9696', 'docker service name'],
    ['http://jellyfin:8096', 'docker service name'],
    ['http://127.0.0.1:32400', 'loopback'],
    ['http://localhost:8080', 'localhost'],
    ['http://192.168.1.20:9696', 'RFC1918'],
    ['http://10.0.0.5:8080', 'RFC1918'],
    ['http://172.16.4.4:8080', 'RFC1918'],
    ['http://nas.local:8096', 'mDNS name'],
    ['https://plex.example.com', 'public https'],
    ['https://nas.example.com/prowlarr', 'reverse-proxy subpath'],
    ['http://[::1]:8080', 'IPv6 loopback'],
  ])('accepts %s (%s)', (url) => {
    expect(() => parseProviderBaseUrl(url, 'Test')).not.toThrow();
  });
});

/**
 * Existing installs must keep working. A scheme-less endpoint is a real,
 * supported configuration — `normalizeBaseUrl` in the analytics importer was
 * added after one made `fetch` throw on a live system — so validation normalises
 * it rather than turning an upgrade into an outage.
 */
describe('a scheme-less endpoint from an existing install', () => {
  it.each([
    ['192.168.1.5:8080', 'http://192.168.1.5:8080/'],
    ['qbittorrent:8080', 'http://qbittorrent:8080/'],
    ['localhost:32400', 'http://localhost:32400/'],
    ['nas.local', 'http://nas.local/'],
  ])('normalises %s to %s rather than rejecting it', (input, expected) => {
    expect(parseProviderBaseUrl(input, 'Test').toString()).toBe(expected);
  });

  /* But a protocol-relative value is not quietly rebuilt into a host. */
  it('does not invent a scheme for a protocol-relative value', () => {
    expect(() => parseProviderBaseUrl('//evil.example/x', 'Test')).toThrow(BadRequestException);
  });
});

describe('what a provider endpoint may not be', () => {
  /* `fetch` cannot speak these, and a provider is never legitimately behind one. */
  it.each(['file:///etc/passwd', 'ftp://host/x', 'gopher://host', 'javascript:alert(1)'])(
    'refuses the scheme in %s',
    (url) => {
      expect(() => parseProviderBaseUrl(url, 'Test')).toThrow(BadRequestException);
    },
  );

  /*
   * A credentialled URL forwards a secret on every request, and reads as a
   * different host to a person than to a parser — `http://real.example@evil.test`
   * goes to evil.test.
   */
  it('refuses embedded credentials', () => {
    expect(() => parseProviderBaseUrl('http://user:pass@qbittorrent:8080', 'Test')).toThrow(
      BadRequestException,
    );
    expect(() => parseProviderBaseUrl('http://real.example@evil.test/', 'Test')).toThrow(
      BadRequestException,
    );
  });

  it('refuses something that is not a URL at all', () => {
    for (const bad of ['', '   ', 'not a url', '://missing-scheme', 'http://']) {
      expect(() => parseProviderBaseUrl(bad, 'Test')).toThrow(BadRequestException);
    }
  });

  it('names the provider in the error, so the wrong field is obvious', () => {
    expect(() => parseProviderBaseUrl('ftp://x', 'qBittorrent')).toThrow(/qBittorrent/);
  });

  /* Cloud metadata is the route from "can make a request" to "has the keys". */
  it('recognises cloud instance-metadata addresses', () => {
    expect(isMetadataAddress('169.254.169.254')).toBe(true);
    expect(isMetadataAddress('fd00:ec2::254')).toBe(true);
    expect(isMetadataAddress('192.168.1.1')).toBe(false);
    expect(isMetadataAddress('127.0.0.1')).toBe(false);
  });
});

/**
 * The join is where a "relative path" can stop being relative. Concatenation is
 * nearly safe; it stops being safe the moment a path is built from data.
 */
describe('joining a path onto a provider base', () => {
  it('keeps the origin for an ordinary API path', () => {
    expect(joinProviderUrl('http://qbittorrent:8080', '/api/v2')).toBe(
      'http://qbittorrent:8080/api/v2',
    );
    expect(joinProviderUrl('http://qbittorrent:8080/', 'api/v2')).toBe(
      'http://qbittorrent:8080/api/v2',
    );
  });

  it('preserves a reverse-proxy subpath', () => {
    expect(joinProviderUrl('https://nas.example/prowlarr', '/api/v1/indexer')).toBe(
      'https://nas.example/prowlarr/api/v1/indexer',
    );
    expect(joinProviderUrl('https://nas.example/prowlarr/', '/api/v1/indexer')).toBe(
      'https://nas.example/prowlarr/api/v1/indexer',
    );
  });

  it('keeps a query string and fragment rather than escaping them into the path', () => {
    expect(joinProviderUrl('http://plex:32400', '/status/sessions?includeGuids=1')).toBe(
      'http://plex:32400/status/sessions?includeGuids=1',
    );
  });

  /*
   * The property that matters. `new URL('//evil.example/x', base)` resolves to
   * evil.example — a protocol-relative path silently replaces the host.
   */
  it.each([
    ['//evil.example/x', 'protocol-relative'],
    ['http://evil.example/x', 'absolute http'],
    ['https://evil.example/x', 'absolute https'],
    ['\\\\evil.example\\x', 'backslashes'],
    ['/\\evil.example/x', 'mixed separators'],
    ['@evil.example/x', 'credential separator'],
    ['../../../etc/passwd', 'traversal'],
  ])('cannot let %s (%s) move the request off the configured host', (path) => {
    const out = new URL(joinProviderUrl('http://qbittorrent:8080', path));
    expect(out.host).toBe('qbittorrent:8080');
    expect(out.protocol).toBe('http:');
  });

  it('cannot change the port', () => {
    const out = new URL(joinProviderUrl('http://plex:32400', '//plex:9999/x'));
    expect(out.port).toBe('32400');
  });
});
