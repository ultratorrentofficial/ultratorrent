import type { NetworkFacts, Fingerprint } from './household-types';

/**
 * Build a NETWORK CLUSTER identity from an address's facts — deliberately NOT the
 * exact IP. A residential ISP hands out dynamic addresses, uses CGNAT, and rotates
 * IPv6 prefixes, so keying on the exact IP would invent a "new network" every few
 * days and produce false sharing alerts. Instead the key is `(ASN‖ISP, country,
 * region, city)`: a dynamic /24 within the same ISP+city stays ONE network.
 *
 * The key is only ever compared WITHIN a single household profile, so two different
 * customers of the same ISP+city never collapse into one household — each has its
 * own network row that happens to share a fingerprint string. (The cross-user
 * Networks view aggregates by fingerprint on purpose; that is reporting, not
 * identity.) The exact /24 is kept as `representativeIp` evidence only.
 */
export function buildFingerprint(facts: NetworkFacts): Fingerprint {
  const base: Omit<Fingerprint, 'fingerprint' | 'representativeIp'> = {
    asn: facts.asn,
    isp: facts.isp,
    countryCode: facts.countryCode,
    country: facts.country,
    region: facts.region,
    city: facts.city,
    latitude: facts.latitude,
    longitude: facts.longitude,
  };

  // Private/LAN or unresolved — not a household network.
  if (facts.kind !== 'public') return { ...base, fingerprint: null, representativeIp: null };

  const net = facts.asn != null ? `as${facts.asn}` : facts.isp ? `isp:${norm(facts.isp)}` : null;
  const cc = facts.countryCode ? facts.countryCode.toUpperCase() : '';
  const rep = representativePrefix(facts.ip);

  if (net && facts.city) {
    // The strong, common case: ISP + placed city.
    return { ...base, fingerprint: `${net}|${cc}|${norm(facts.region)}|${norm(facts.city)}`, representativeIp: rep };
  }
  if (net) {
    // ISP known but no city — cluster by ISP + country, still not by exact IP.
    return { ...base, fingerprint: `${net}|${cc}`, representativeIp: rep };
  }
  if (rep) {
    // No ISP/geo at all — fall back to the coarse prefix so evidence is retained
    // at reduced confidence (feature still works with no ASN database).
    return { ...base, fingerprint: `prefix:${rep}`, representativeIp: rep };
  }
  return { ...base, fingerprint: null, representativeIp: null };
}

const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

/**
 * The coarse prefix kept as evidence: IPv4 /24, IPv6 /48. Never the fingerprint key
 * on its own where ISP+city is available (that would over-split on DHCP), but a
 * useful representative and the only signal when there is no geo/ASN data.
 */
export function representativePrefix(ip: string): string | null {
  const addr = (ip ?? '').trim();
  if (!addr) return null;
  if (addr.includes('.')) {
    const parts = addr.split('.');
    if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
    return null;
  }
  if (addr.includes(':')) {
    // Expand only enough to take the first three hextets (/48).
    const hextets = addr.split('%')[0].split(':');
    const head = hextets.slice(0, 3).map((h) => h || '0');
    if (head.length === 3) return `${head.join(':')}::/48`;
  }
  return null;
}
