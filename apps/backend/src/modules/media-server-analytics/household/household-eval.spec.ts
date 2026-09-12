import { evaluateHousehold, inferHome } from './household-eval';
import { DEFAULT_THRESHOLDS, NetworkAgg, SessionWindow } from './household-types';

const NOW = new Date('2026-09-12T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

const net = (over: Partial<NetworkAgg> & { id: string }): NetworkAgg => ({
  fingerprint: over.id, networkType: 'residential', playCount: 30, watchSeconds: 40000, distinctDays: 20,
  uniqueDevices: 1, firstSeenAt: daysAgo(60), lastSeenAt: daysAgo(1), trusted: false, ignored: false,
  disposition: null, latitude: 39.9, longitude: -83.8, city: 'Springfield', isp: 'Charter', ...over,
});

// A window on a network at a given hour offset from NOW, lasting `mins`.
const win = (networkId: string, dayOffset: number, hour: number, mins: number, deviceFamily: string | null = 'roku'): SessionWindow => {
  const start = new Date(NOW.getTime() - dayOffset * 86_400_000);
  start.setUTCHours(hour, 0, 0, 0);
  return { networkId, startedAt: start, endedAt: new Date(start.getTime() + mins * 60_000), deviceFamily };
};

const evl = (networks: NetworkAgg[], windows: SessionWindow[] = [], over: Partial<Parameters<typeof evaluateHousehold>[0]> = {}) =>
  evaluateHousehold({ networks, windows, currentHomeId: null, homeLocked: false, now: NOW, ...over });

const codes = (r: ReturnType<typeof evl>) => r.risk.reasons.map((x) => x.code);

describe('household evaluation — home learning', () => {
  it('learns a home from a single established residential network', () => {
    const r = evl([net({ id: 'home' })]);
    expect(r.homeNetworkId).toBe('home');
    expect(r.homeConfidence).toBeGreaterThan(0);
    expect(r.risk.score).toBe(0); // one home, nothing else
  });

  it('SAME HOME / NEW IP: a stable residential network stays home, low risk', () => {
    // Fingerprint stability is covered separately; here the same network id persists.
    const r = evl([net({ id: 'home', lastSeenAt: NOW })]);
    expect(r.homeNetworkId).toBe('home');
    expect(r.risk.level).toBe('none');
  });

  it('does not learn a home from too-little evidence', () => {
    const r = inferHome([net({ id: 'x', distinctDays: 1, playCount: 1, watchSeconds: 100, firstSeenAt: daysAgo(1) })], DEFAULT_THRESHOLDS, NOW.getTime());
    expect(r.homeId).toBeNull();
  });

  it('never picks mobile/hosting/vpn as home', () => {
    const r = inferHome([
      net({ id: 'mob', networkType: 'mobile', watchSeconds: 999999, distinctDays: 30 }),
      net({ id: 'res', networkType: 'residential' }),
    ], DEFAULT_THRESHOLDS, NOW.getTime());
    expect(r.homeId).toBe('res');
  });

  it('LOCKED HOME is not replaced by a newly dominant network', () => {
    const r = evl(
      [net({ id: 'oldHome', watchSeconds: 20000 }), net({ id: 'newBig', watchSeconds: 500000, distinctDays: 40 })],
      [],
      { currentHomeId: 'oldHome', homeLocked: true },
    );
    expect(r.homeNetworkId).toBe('oldHome');
    expect(r.suggestedHomeId).toBe('newBig'); // surfaced, not applied
  });
});

describe('household evaluation — mobile & travel are conservative', () => {
  it('MOBILE use adds no sharing risk and does not displace home', () => {
    const r = evl([net({ id: 'home' }), net({ id: 'cell', networkType: 'mobile', city: 'Orlando', latitude: 28.5, longitude: -81.4 })]);
    expect(r.homeNetworkId).toBe('home');
    expect(r.risk.score).toBe(0);
    expect(codes(r)).toContain('mobile_networks_present');
    expect(codes(r)).not.toContain('new_residential_network');
    expect(codes(r)).not.toContain('simultaneous_residential_networks');
  });

  it('a network marked TRAVEL is discounted to zero', () => {
    const r = evl([net({ id: 'home' }), net({ id: 'trip', city: 'Orlando', disposition: 'travel', distinctDays: 4 })]);
    expect(r.risk.score).toBe(0);
    expect(codes(r)).toContain('travel_network');
  });

  it('a TRUSTED second residential network neutralizes risk (second home)', () => {
    const r = evl([net({ id: 'home' }), net({ id: 'home2', city: 'Cleveland', trusted: true, distinctDays: 15 })]);
    expect(codes(r)).toContain('trusted_network');
    expect(r.risk.score).toBe(0);
  });

  it('an IGNORED network is excluded entirely', () => {
    const r = evl([net({ id: 'home' }), net({ id: 'ig', city: 'Orlando', ignored: true, distinctDays: 20 })]);
    expect(r.risk.reasons.filter((x) => x.details && (x.details as { networkId?: string }).networkId === 'ig')).toHaveLength(0);
  });
});

describe('household evaluation — residential sharing signals', () => {
  it('a persistent second residential network raises risk', () => {
    const r = evl([net({ id: 'home' }), net({ id: 'second', city: 'Orlando', latitude: 28.5, longitude: -81.4, distinctDays: 19 })]);
    expect(codes(r)).toContain('persistent_secondary_residential_network');
    expect(codes(r)).toContain('large_geographic_separation');
    expect(r.risk.score).toBeGreaterThan(0);
  });

  it('a brand-new residential network is only a mild signal', () => {
    const r = evl([net({ id: 'home' }), net({ id: 'new', city: 'Toledo', distinctDays: 1, latitude: 41.6, longitude: -83.5 })]);
    expect(codes(r)).toContain('new_residential_network');
    expect(r.risk.level === 'none' || r.risk.level === 'low').toBe(true);
  });

  it('SIMULTANEOUS distant residential streams are a strong signal', () => {
    const r = evl(
      [net({ id: 'home' }), net({ id: 'pr', city: 'San Juan', latitude: 18.4, longitude: -66.1, isp: 'Liberty', distinctDays: 6 })],
      [win('home', 1, 20, 60, 'roku'), win('pr', 1, 20, 60, 'lg_webos')], // overlapping, different devices
    );
    expect(codes(r)).toContain('simultaneous_residential_networks');
    expect(codes(r)).toContain('concurrent_different_devices');
    expect(r.risk.reviewRequired).toBe(true);
    expect(r.risk.score).toBeGreaterThanOrEqual(50);
  });

  it('REPEATED simultaneous usage escalates further', () => {
    const r = evl(
      [net({ id: 'home' }), net({ id: 'pr', city: 'San Juan', latitude: 18.4, longitude: -66.1, distinctDays: 10 })],
      [win('home', 1, 20, 60), win('pr', 1, 20, 60), win('home', 2, 21, 60), win('pr', 2, 21, 60)],
    );
    expect(codes(r)).toContain('repeated_simultaneous_usage');
    expect(r.risk.level === 'high' || r.risk.level === 'critical').toBe(true);
  });

  it('SEQUENTIAL sessions (no time overlap) are NOT simultaneous', () => {
    const r = evl(
      [net({ id: 'home' }), net({ id: 'pr', city: 'San Juan', latitude: 18.4, longitude: -66.1, distinctDays: 6 })],
      [win('home', 1, 18, 60), win('pr', 1, 20, 60)], // 18:00-19:00 then 20:00-21:00 — no overlap
    );
    expect(codes(r)).not.toContain('simultaneous_residential_networks');
  });
});

describe('household evaluation — VPN/hosting and unknown are conservative', () => {
  it('a VPN/hosting network is review-worthy, not confirmed sharing', () => {
    const r = evl([net({ id: 'home' }), net({ id: 'vpn', networkType: 'vpn_proxy', city: null, distinctDays: 5 })]);
    expect(codes(r)).toContain('vpn_or_hosting_network');
    expect(r.risk.level === 'low' || r.risk.level === 'medium' || r.risk.level === 'none').toBe(true);
  });

  it('unknown-type networks do not fabricate residential sharing signals', () => {
    const r = evl([net({ id: 'home' }), net({ id: 'u', networkType: 'unknown', city: null, distinctDays: 10 })]);
    expect(codes(r)).not.toContain('persistent_secondary_residential_network');
  });

  it('degrades safely with no geo (still no crash, no false home)', () => {
    const r = evl([net({ id: 'u', networkType: 'unknown', city: null, latitude: null, longitude: null, isp: null, firstSeenAt: daysAgo(30) })]);
    expect(r.homeNetworkId).toBeNull(); // unknown type can't be home
    expect(r.risk.score).toBe(0);
  });
});
