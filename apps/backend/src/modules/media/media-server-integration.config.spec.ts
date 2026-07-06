import { MediaServerIntegrationService } from './media-server-integration.service';

/**
 * Regression for the "baseUrl is required" bug: the settings form persisted the
 * server address under `url`, but providers read `baseUrl`. decryptConfig must
 * alias `url` → `baseUrl` so both stored shapes reach the provider.
 */
describe('MediaServerIntegrationService.decryptConfig url→baseUrl alias', () => {
  // Cipher stub: passthrough so we only exercise the key normalization.
  const cipher = { encrypt: (v: string) => v, decrypt: (v: string) => v } as any;
  const svc = new MediaServerIntegrationService({} as any, cipher, {} as any);
  const decrypt = (stored: Record<string, unknown>) => (svc as any).decryptConfig(stored);

  it('aliases a legacy `url` config to baseUrl', () => {
    const cfg = decrypt({ url: 'http://plex.local:32400', token: 'abc' });
    expect(cfg.baseUrl).toBe('http://plex.local:32400');
    expect(cfg.token).toBe('abc');
  });

  it('prefers an explicit baseUrl over url when both are present', () => {
    const cfg = decrypt({ baseUrl: 'http://a:32400', url: 'http://b:32400' });
    expect(cfg.baseUrl).toBe('http://a:32400');
  });

  it('leaves baseUrl untouched when no url is present', () => {
    const cfg = decrypt({ baseUrl: 'http://only:32400' });
    expect(cfg.baseUrl).toBe('http://only:32400');
  });
});
