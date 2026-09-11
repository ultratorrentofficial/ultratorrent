import { GeoIpSettingsService, REDACTED } from './geoip-settings.service';

const cipher = {
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => (s.startsWith('enc:') ? s.slice(4) : (() => { throw new Error('bad'); })()),
};

function withStore(initial: Record<string, unknown> | null = null) {
  let value = initial;
  const settings = {
    get: async () => value,
    set: async (_k: string, v: Record<string, unknown>) => { value = v; },
  };
  return { svc: new GeoIpSettingsService(settings as never, cipher as never), read: () => value };
}

describe('GeoIpSettingsService', () => {
  it('encrypts the licence key at rest and never returns it', async () => {
    const { svc, read } = withStore();
    const out = await svc.update({ accountId: '12345', licenseKey: 'secret-key' });
    expect((read() as Record<string, unknown>).licenseKey).toBe('enc:secret-key');
    expect((read() as Record<string, unknown>).__licenseKeyEncrypted).toBe(true);
    // The client view is redacted but flags presence.
    expect(out.licenseKey).toBe(REDACTED);
    expect(out.hasLicenseKey).toBe(true);
    expect(out.accountId).toBe('12345');
  });

  it('keeps the existing key when the redacted placeholder is echoed back', async () => {
    const { svc } = withStore();
    await svc.update({ accountId: 'a', licenseKey: 'keep-me' });
    await svc.update({ licenseKey: REDACTED, autoUpdate: true });
    const internal = await svc.read();
    expect(internal.licenseKey).toBe('keep-me');
    expect(internal.autoUpdate).toBe(true);
  });

  it('clears the key on an explicit empty value', async () => {
    const { svc } = withStore();
    await svc.update({ accountId: 'a', licenseKey: 'x' });
    await svc.update({ licenseKey: '' });
    expect((await svc.read()).licenseKey).toBeNull();
    expect(await svc.isConfigured()).toBe(false);
  });

  it('reports configured only when both credentials are present', async () => {
    const { svc } = withStore();
    await svc.update({ accountId: 'a' });
    expect(await svc.isConfigured()).toBe(false);
    await svc.update({ licenseKey: 'k' });
    expect(await svc.isConfigured()).toBe(true);
  });

  it('rejects an empty edition list and a sub-hour interval', async () => {
    const { svc } = withStore();
    await expect(svc.update({ editions: ['not-a-real-edition'] })).rejects.toThrow();
    await expect(svc.update({ updateIntervalHours: 0 })).rejects.toThrow();
  });

  it('drops unknown editions and de-duplicates', async () => {
    const { svc } = withStore();
    const out = await svc.update({ editions: ['GeoLite2-City', 'bogus', 'GeoLite2-City', 'GeoLite2-ASN'] });
    expect(out.editions).toEqual(['GeoLite2-City', 'GeoLite2-ASN']);
  });
});
