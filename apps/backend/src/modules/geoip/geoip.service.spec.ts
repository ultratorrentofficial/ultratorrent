import { GeoIpService, isPrivateAddress } from './geoip.service';

describe('isPrivateAddress', () => {
  it.each([
    '10.0.0.5', '192.168.1.10', '172.16.4.4', '172.31.255.1', '127.0.0.1',
    '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd12:3456::1',
    '::ffff:192.168.1.1',
  ])('treats %s as local', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '72.46.159.10', '2606:4700::1111', '::ffff:8.8.8.8'])(
    'treats %s as public',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );

  it('is not fooled by a public 172 that is outside the private range', () => {
    expect(isPrivateAddress('172.15.0.1')).toBe(false);
    expect(isPrivateAddress('172.32.0.1')).toBe(false);
  });
});

describe('GeoIpService without a database', () => {
  const svc = () => new GeoIpService();

  it('reports unavailable and never throws', async () => {
    const s = svc();
    expect(s.available).toBe(false);
    // A missing GEOIP_DB_PATH must degrade to unknown, not crash a page render.
    await expect(s.lookup('8.8.8.8')).resolves.toEqual({ ip: '8.8.8.8', kind: 'unknown', location: null, isp: null, asn: null });
  });

  it('short-circuits a private address before any database is needed', async () => {
    const s = svc();
    await expect(s.lookup('192.168.1.50')).resolves.toEqual({
      ip: '192.168.1.50',
      kind: 'private',
      location: null,
      isp: null,
      asn: null,
    });
  });

  it('returns unknown for an empty address', async () => {
    await expect(svc().lookup('  ')).resolves.toEqual({ ip: '', kind: 'unknown', location: null, isp: null, asn: null });
  });

  it('de-duplicates a batch to one result per address', async () => {
    const s = svc();
    const out = await s.lookupMany(['8.8.8.8', '8.8.8.8', '10.0.0.1', null, '']);
    expect(out.size).toBe(2);
    expect(out.get('8.8.8.8')?.kind).toBe('unknown');
    expect(out.get('10.0.0.1')?.kind).toBe('private');
  });
});

describe('GeoIpService with a stubbed reader', () => {
  /*
   * The reader is loaded lazily via a dynamic import of maxmind and a real file.
   * Rather than ship a fixture .mmdb, drive the resolution path by injecting a
   * fake reader and asserting the flatten + "public but unplaced" logic.
   */
  const withReader = (get: (ip: string) => unknown, asnGet?: (ip: string) => unknown) => {
    const s = new GeoIpService();
    (s as unknown as { reader: unknown }).reader = { get };
    (s as unknown as { ensureLoaded: () => Promise<void> }).ensureLoaded = async () => undefined;
    (s as unknown as { ensureAsnLoaded: () => Promise<void> }).ensureAsnLoaded = async () => undefined;
    if (asnGet) (s as unknown as { asnReader: unknown }).asnReader = { get: asnGet };
    return s;
  };

  it('flattens a full city hit to the fields a card shows', async () => {
    const s = withReader(() => ({
      country: { iso_code: 'us', names: { en: 'United States' } },
      subdivisions: [{ names: { en: 'California' } }],
      city: { names: { en: 'Mountain View' } },
      location: { latitude: 37.4, longitude: -122.07 },
    }));
    const r = await s.lookup('8.8.8.8');
    expect(r.kind).toBe('public');
    expect(r.location).toEqual({
      countryCode: 'US',
      country: 'United States',
      region: 'California',
      city: 'Mountain View',
      latitude: 37.4,
      longitude: -122.07,
    });
  });

  it('reports a public address the database cannot place as public with no location', async () => {
    const s = withReader(() => null);
    const r = await s.lookup('203.0.113.7');
    expect(r).toEqual({ ip: '203.0.113.7', kind: 'public', location: null, isp: null, asn: null });
  });

  it('degrades a reader that throws to unknown', async () => {
    const s = withReader(() => {
      throw new Error('corrupt');
    });
    await expect(s.lookup('8.8.8.8')).resolves.toEqual({ ip: '8.8.8.8', kind: 'unknown', location: null, isp: null, asn: null });
  });

  it('attaches ISP/ASN from the ASN database when present', async () => {
    const s = withReader(
      () => ({ country: { iso_code: 'us', names: { en: 'United States' } } }),
      () => ({ autonomous_system_number: 15169, autonomous_system_organization: 'GOOGLE' }),
    );
    const r = await s.lookup('8.8.8.8');
    expect(r.isp).toBe('GOOGLE');
    expect(r.asn).toBe(15169);
    expect(r.location?.countryCode).toBe('US');
  });
});
