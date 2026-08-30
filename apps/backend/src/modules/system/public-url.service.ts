import { connect as tlsConnect, type PeerCertificate } from 'node:tls';
import { lookup } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

const PUBLIC_URL_KEY = 'system.public_url';

/** Long enough for a slow home connection, short enough that Settings still feels live. */
const PROBE_TIMEOUT_MS = 6_000;

/** Let's Encrypt warns at 30 days; below 14 the operator should already be worried. */
const CERT_WARN_DAYS = 30;
const CERT_CRITICAL_DAYS = 14;

interface PublicUrlConfig {
  url?: string;
}

export interface CertificateInfo {
  subject: string | null;
  issuer: string | null;
  validFrom: string | null;
  validTo: string | null;
  daysRemaining: number | null;
  /** Issued by a public CA the system trusts, rather than by itself. */
  trusted: boolean;
  selfSigned: boolean;
  /** The certificate actually covers the hostname the URL uses. */
  hostnameMatches: boolean;
  trustError: string | null;
}

export interface PublicUrlStatus {
  url: string | null;
  host: string | null;
  port: number | null;
  scheme: 'http' | 'https' | null;
  dns: { resolved: boolean; addresses: string[]; error: string | null };
  reachable: boolean;
  httpStatus: number | null;
  reachError: string | null;
  certificate: CertificateInfo | null;
  /**
   * Whether this host could obtain a Let's Encrypt certificate today. HTTP-01 is
   * the only method that needs nothing but a forwarded port, and it validates on
   * port 80 exclusively — RFC 8555 fixes that, and redirects to other ports are
   * rejected. So port 80 is the single thing worth probing.
   */
  acme: { port80Reachable: boolean; error: string | null };
  verdict: 'unset' | 'ok' | 'expiring' | 'untrusted' | 'insecure' | 'unreachable';
  checkedAt: string;
}

/**
 * The instance's public URL: the one address that is true from outside the
 * network, and therefore the only one safe to put in a link somebody else will
 * open — a newsletter, an unsubscribe, a shared report.
 *
 * The service stores and validates that URL, and reports what is actually true
 * about it by connecting to it: DNS, reachability, the certificate on the wire
 * and its remaining life, and whether port 80 is open for an ACME challenge.
 *
 * **It deliberately does not obtain certificates.** The backend runs in a
 * container that does not hold ports 80 or 443, cannot write to the proxy's
 * webroot and cannot reload it, so an in-app certbot would be a button that
 * fails on every installation that actually needs it. Issuance belongs to
 * whatever terminates TLS — the bundled proxy, or the host's own. What this
 * service can do honestly is tell the operator whether issuance would succeed
 * and, once a certificate exists, whether it is trusted and when it expires.
 */
@Injectable()
export class PublicUrlService {
  private readonly logger = new Logger(PublicUrlService.name);

  constructor(private readonly prisma: PrismaService) {}

  // --- settings ------------------------------------------------------------
  private async raw(): Promise<PublicUrlConfig> {
    const row = await this.prisma.setting.findUnique({ where: { key: PUBLIC_URL_KEY } });
    return (row?.value as PublicUrlConfig) ?? {};
  }

  async get(): Promise<{ url: string }> {
    return { url: (await this.raw()).url ?? '' };
  }

  /**
   * Normalise to a bare origin. A base URL that carries a path, a query or
   * credentials produces broken links when something appends to it, and the
   * failure shows up in a stranger's inbox rather than here — so it is rejected
   * at the point of entry instead of being silently trimmed.
   */
  normalize(input: string): string {
    const trimmed = input.trim();
    if (trimmed === '') return '';

    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new BadRequestException('publicUrl.invalid');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException('publicUrl.scheme');
    }
    if (parsed.username || parsed.password) throw new BadRequestException('publicUrl.credentials');
    if (parsed.search || parsed.hash) throw new BadRequestException('publicUrl.query');
    if (parsed.pathname !== '/' && parsed.pathname !== '') throw new BadRequestException('publicUrl.path');
    if (!parsed.hostname) throw new BadRequestException('publicUrl.invalid');

    // `origin` drops a default port, which is what we want: :443 on https is
    // noise, while a non-default port like :10443 is load-bearing and kept.
    return parsed.origin;
  }

  async set(input: string): Promise<{ url: string }> {
    const url = this.normalize(input);
    const next: PublicUrlConfig = { ...(await this.raw()), url };
    await this.prisma.setting.upsert({
      where: { key: PUBLIC_URL_KEY },
      create: { key: PUBLIC_URL_KEY, value: next as object },
      update: { value: next as object },
    });
    return { url };
  }

  /**
   * The configured public URL, or null. Callers that build a link for somebody
   * else should use this and omit the link entirely when it is null — a relative
   * or guessed URL in an email is worse than no link, because it looks like it
   * works.
   */
  async baseUrl(): Promise<string | null> {
    const { url } = await this.raw();
    return url && url.length > 0 ? url : null;
  }

  // --- probes --------------------------------------------------------------
  async status(): Promise<PublicUrlStatus> {
    const checkedAt = new Date().toISOString();
    const url = await this.baseUrl();
    if (!url) {
      return {
        url: null, host: null, port: null, scheme: null,
        dns: { resolved: false, addresses: [], error: null },
        reachable: false, httpStatus: null, reachError: null,
        certificate: null,
        acme: { port80Reachable: false, error: null },
        verdict: 'unset', checkedAt,
      };
    }

    const parsed = new URL(url);
    const scheme = parsed.protocol === 'https:' ? 'https' : 'http';
    const port = parsed.port ? Number(parsed.port) : scheme === 'https' ? 443 : 80;

    // Run the probes together: they are independent, and three sequential
    // timeouts would make a misconfigured URL take 18s to report.
    const [dns, reach, certificate, acme] = await Promise.all([
      this.probeDns(parsed.hostname),
      this.probeReach(url),
      scheme === 'https' ? this.probeCertificate(parsed.hostname, port) : Promise.resolve(null),
      this.probeAcmePort(parsed.hostname),
    ]);

    return {
      url, host: parsed.hostname, port, scheme,
      dns, ...reach, certificate, acme,
      verdict: this.verdict(scheme, reach.reachable, certificate),
      checkedAt,
    };
  }

  private verdict(
    scheme: 'http' | 'https',
    reachable: boolean,
    cert: CertificateInfo | null,
  ): PublicUrlStatus['verdict'] {
    if (!reachable) return 'unreachable';
    if (scheme === 'http') return 'insecure';
    if (!cert) return 'unreachable';
    if (!cert.trusted || !cert.hostnameMatches) return 'untrusted';
    if (cert.daysRemaining != null && cert.daysRemaining <= CERT_WARN_DAYS) return 'expiring';
    return 'ok';
  }

  private async probeDns(host: string): Promise<PublicUrlStatus['dns']> {
    try {
      const results = await lookup(host, { all: true });
      return { resolved: results.length > 0, addresses: results.map((r) => r.address), error: null };
    } catch (err) {
      return { resolved: false, addresses: [], error: (err as Error).message };
    }
  }

  private async probeReach(
    url: string,
  ): Promise<{ reachable: boolean; httpStatus: number | null; reachError: string | null }> {
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      // Any status is a reachable server. A 401 or a 302 to the login page still
      // proves the address routes here, which is the question being asked.
      return { reachable: true, httpStatus: res.status, reachError: null };
    } catch (err) {
      return { reachable: false, httpStatus: null, reachError: (err as Error).message };
    }
  }

  /**
   * Read the certificate the way a browser would. Two connections, because they
   * answer different questions: the first accepts anything so the certificate
   * can be described even when it is self-signed or expired (describing it is
   * the whole point of the screen), the second enforces trust so the report can
   * say whether a real browser would object.
   */
  private async probeCertificate(host: string, port: number): Promise<CertificateInfo | null> {
    const peer = await this.peerCertificate(host, port, false).catch(() => null);
    if (!peer) return null;

    const trustError = await this.peerCertificate(host, port, true).then(
      () => null,
      (err: Error) => err.message,
    );

    const validTo = peer.valid_to ? new Date(peer.valid_to) : null;
    const daysRemaining =
      validTo && !Number.isNaN(validTo.getTime())
        ? Math.floor((validTo.getTime() - Date.now()) / 86_400_000)
        : null;

    // A CN is multi-valued in X.509; node surfaces that as an array. Take the
    // first rather than rendering "a,b" into the UI.
    const firstCn = (cn: string | string[] | undefined): string | null =>
      Array.isArray(cn) ? (cn[0] ?? null) : (cn ?? null);
    const subject = firstCn(peer.subject?.CN);
    const issuer = firstCn(peer.issuer?.CN);

    return {
      subject,
      issuer,
      validFrom: peer.valid_from ?? null,
      validTo: peer.valid_to ?? null,
      daysRemaining,
      trusted: trustError === null,
      // A certificate that issued itself. Worth naming separately from "not
      // trusted", because the fix is different: get a real one, not install a CA.
      selfSigned: Boolean(subject && issuer && subject === issuer),
      hostnameMatches: trustError === null || !/altnames|Host:|does not match/i.test(trustError),
      trustError,
    };
  }

  private peerCertificate(host: string, port: number, verify: boolean): Promise<PeerCertificate> {
    return new Promise((resolve, reject) => {
      const socket = tlsConnect(
        { host, port, servername: host, rejectUnauthorized: verify, timeout: PROBE_TIMEOUT_MS },
        () => {
          const cert = socket.getPeerCertificate();
          socket.end();
          if (!cert || Object.keys(cert).length === 0) reject(new Error('no certificate presented'));
          else resolve(cert);
        },
      );
      socket.on('error', (err) => { socket.destroy(); reject(err); });
      socket.on('timeout', () => { socket.destroy(); reject(new Error('timed out')); });
    });
  }

  /**
   * Can Let's Encrypt reach port 80? A random challenge-shaped path is requested:
   * a 404 is a pass, because it proves something answered on 80 — only the
   * connection matters, not what it said. The path is random so a cached or
   * leftover challenge file cannot make a closed port look open.
   */
  private async probeAcmePort(host: string): Promise<PublicUrlStatus['acme']> {
    const probe = `http://${host}/.well-known/acme-challenge/${randomBytes(9).toString('hex')}`;
    try {
      await fetch(probe, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return { port80Reachable: true, error: null };
    } catch (err) {
      return { port80Reachable: false, error: (err as Error).message };
    }
  }
}
