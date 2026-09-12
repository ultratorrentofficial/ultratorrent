import { buildFingerprint, representativePrefix } from './network-fingerprint';
import type { NetworkFacts } from './household-types';

const facts = (over: Partial<NetworkFacts>): NetworkFacts => ({
  ip: '203.0.113.10', kind: 'public', asn: 20115, isp: 'Charter', countryCode: 'US',
  country: 'United States', region: 'Ohio', city: 'Springfield', latitude: 39.9, longitude: -83.8, ...over,
});

describe('buildFingerprint — a network cluster, not one exact IP', () => {
  it('gives a dynamic IP within the same ISP+city the SAME fingerprint', () => {
    const a = buildFingerprint(facts({ ip: '74.139.6.118' }));
    const b = buildFingerprint(facts({ ip: '74.139.200.4' })); // DHCP moved the address
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.representativeIp).not.toBe(b.representativeIp); // /24 differs, but it is evidence only
  });
  it('separates different cities on the same ISP', () => {
    const ohio = buildFingerprint(facts({ city: 'Springfield', region: 'Ohio' }));
    const florida = buildFingerprint(facts({ city: 'Orlando', region: 'Florida' }));
    expect(ohio.fingerprint).not.toBe(florida.fingerprint);
  });
  it('separates different ISPs in the same city', () => {
    const charter = buildFingerprint(facts({ asn: 20115, isp: 'Charter' }));
    const liberty = buildFingerprint(facts({ asn: 14638, isp: 'Liberty' }));
    expect(charter.fingerprint).not.toBe(liberty.fingerprint);
  });
  it('clusters by ISP+country when the city is unknown', () => {
    const fp = buildFingerprint(facts({ city: null, region: null }));
    expect(fp.fingerprint).toBe('as20115|US');
  });
  it('falls back to a coarse /24 prefix with no ISP/geo (reduced confidence)', () => {
    const fp = buildFingerprint({ ip: '198.51.100.77', kind: 'public', asn: null, isp: null, countryCode: null, country: null, region: null, city: null, latitude: null, longitude: null });
    expect(fp.fingerprint).toBe('prefix:198.51.100.0/24');
  });
  it('returns no fingerprint for a private/LAN address', () => {
    expect(buildFingerprint(facts({ kind: 'private' })).fingerprint).toBeNull();
  });
  it('computes /24 and /48 prefixes', () => {
    expect(representativePrefix('74.139.6.118')).toBe('74.139.6.0/24');
    expect(representativePrefix('2001:db8:abcd:1234::1')).toBe('2001:db8:abcd::/48');
  });
});
