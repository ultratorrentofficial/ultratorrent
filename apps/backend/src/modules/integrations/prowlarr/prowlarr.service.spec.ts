import { BadRequestException } from '@nestjs/common';
import { ProwlarrIntegrationService } from './prowlarr.service';
import { parseProwlarrUrl, isMetadataAddress } from './prowlarr-url';

function build() {
  const store = new Map<string, any>();
  const prisma = {
    setting: {
      findUnique: jest.fn(async ({ where }: any) => (store.has(where.key) ? { key: where.key, value: store.get(where.key) } : null)),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const value = store.has(where.key) ? update.value : create.value;
        store.set(where.key, value);
        return { key: where.key, value };
      }),
    },
  };
  const cipher = { encrypt: jest.fn((s: string) => `enc:${s}`), decrypt: jest.fn((s: string) => s.replace(/^enc:/, '')) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const svc = new ProwlarrIntegrationService(prisma as any, cipher as any, audit as any);
  return { svc, prisma, cipher, audit, store };
}

function mockFetch(handler: (url: string, init: any) => { status?: number; ok?: boolean; body?: any }) {
  (global as any).fetch = jest.fn(async (url: string, init: any) => {
    const r = handler(String(url), init);
    const status = r.status ?? 200;
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    return {
      status,
      ok: r.ok ?? (status >= 200 && status < 300),
      headers: { get: () => String(text.length) },
      text: async () => text,
    };
  });
}

afterEach(() => {
  jest.restoreAllMocks();
  delete (global as any).fetch;
});

describe('ProwlarrIntegrationService — settings & secrets', () => {
  it('encrypts the apiKey on save and never returns plaintext/ciphertext', async () => {
    const { svc, cipher, store } = build();
    const res = await svc.update({ apiKey: 'topsecret', enabled: true, internalUrl: 'http://prowlarr:9696' });
    expect(cipher.encrypt).toHaveBeenCalledWith('topsecret');
    expect(res.apiKey).toBe('••••••••');
    expect(res.hasApiKey).toBe(true);
    // Persisted value is ciphertext + marker, not the plaintext.
    const stored = store.get('prowlarr.settings');
    expect(stored.apiKey).toBe('enc:topsecret');
    expect(stored.__encrypted).toEqual(['apiKey']);
  });

  it('reports an empty apiKey mask when none is stored', async () => {
    const { svc } = build();
    const res = await svc.update({ enabled: false });
    expect(res.apiKey).toBe('');
    expect(res.hasApiKey).toBe(false);
  });

  it('keeps the existing apiKey when update sends the mask placeholder', async () => {
    const { svc, cipher } = build();
    await svc.update({ apiKey: 'orig' });
    cipher.encrypt.mockClear();
    const res = await svc.update({ apiKey: '••••••••', enabled: true });
    // orig is decrypted then re-encrypted (encrypt called with the plaintext, not the mask)
    expect(cipher.encrypt).toHaveBeenCalledWith('orig');
    expect(cipher.encrypt).not.toHaveBeenCalledWith('••••••••');
    expect(res.hasApiKey).toBe(true);
  });

  it('replaces the apiKey when update sends a new value and audits the change', async () => {
    const { svc, cipher, audit } = build();
    await svc.update({ apiKey: 'orig' });
    cipher.encrypt.mockClear();
    audit.record.mockClear();
    await svc.update({ apiKey: 'rotated' });
    expect(cipher.encrypt).toHaveBeenCalledWith('rotated');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'prowlarr.apikey.changed' }));
  });

  it('audits settings updates and views', async () => {
    const { svc, audit } = build();
    await svc.update({ enabled: true }, { userId: 'u1' });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'prowlarr.settings.updated' }));
    audit.record.mockClear();
    await svc.get({ userId: 'u1' });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'prowlarr.settings.viewed' }));
  });
});

describe('ProwlarrIntegrationService — URL validation & SSRF', () => {
  it('rejects a non-http(s) scheme', async () => {
    const { svc } = build();
    await expect(svc.update({ internalUrl: 'file:///etc/passwd' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a URL carrying credentials', () => {
    expect(() => parseProwlarrUrl('http://user:pass@prowlarr:9696')).toThrow(BadRequestException);
  });

  it('allows a private/docker host (the intended target)', () => {
    expect(parseProwlarrUrl('http://prowlarr:9696').hostname).toBe('prowlarr');
  });

  it('flags the cloud metadata address', () => {
    expect(isMetadataAddress('169.254.169.254')).toBe(true);
    expect(isMetadataAddress('10.0.0.5')).toBe(false);
  });

  it('blocks a test against the cloud metadata IP', async () => {
    const { svc } = build();
    mockFetch(() => ({ body: {} }));
    const res = await svc.testConnection({ internalUrl: 'http://169.254.169.254', apiKey: 'k' });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/blocked/i);
  });
});

describe('ProwlarrIntegrationService — connection test', () => {
  it('requires an API key', async () => {
    const { svc } = build();
    await expect(svc.testConnection({ internalUrl: 'http://prowlarr:9696' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('succeeds and records version + indexer count', async () => {
    const { svc, audit, store } = build();
    mockFetch((url) => {
      if (url.includes('/system/status')) return { body: { version: '1.21.0' } };
      if (url.includes('/indexer')) return { body: [{ id: 1 }, { id: 2 }, { id: 3 }] };
      return { status: 404, ok: false };
    });
    const res = await svc.testConnection({ internalUrl: 'http://prowlarr:9696', apiKey: 'k' });
    expect(res.ok).toBe(true);
    expect(res.version).toBe('1.21.0');
    expect(res.indexerCount).toBe(3);
    expect(store.get('prowlarr.settings').status).toBe('ok');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'prowlarr.test', result: 'success' }));
  });

  it('sends the API key as X-Api-Key and never in the URL', async () => {
    const { svc } = build();
    const spy = jest.fn(() => ({ body: { version: '1.0' } }));
    mockFetch(spy as any);
    await svc.testConnection({ internalUrl: 'http://prowlarr:9696', apiKey: 's3cr3t' });
    const [url, init] = (global as any).fetch.mock.calls[0];
    expect(String(url)).not.toContain('s3cr3t');
    expect(init.headers['X-Api-Key']).toBe('s3cr3t');
    expect(init.redirect).toBe('error');
  });

  it('reports a rejected API key (401) as failure and persists error status', async () => {
    const { svc, store } = build();
    mockFetch(() => ({ status: 401, ok: false }));
    const res = await svc.testConnection({ internalUrl: 'http://prowlarr:9696', apiKey: 'bad' });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/api key/i);
    expect(store.get('prowlarr.settings').status).toBe('error');
  });

  it('falls back to the stored key when the test DTO omits it', async () => {
    const { svc } = build();
    await svc.update({ apiKey: 'stored-key', internalUrl: 'http://prowlarr:9696', enabled: true });
    const spy = jest.fn(() => ({ body: { version: '2.0' } }));
    mockFetch(spy as any);
    const res = await svc.testConnection({});
    expect(res.ok).toBe(true);
    const [, init] = (global as any).fetch.mock.calls[0];
    expect(init.headers['X-Api-Key']).toBe('stored-key');
  });
});

describe('ProwlarrIntegrationService — status & open', () => {
  it('returns disabled without calling out when disabled', async () => {
    const { svc } = build();
    (global as any).fetch = jest.fn();
    const res = await svc.status();
    expect(res.status).toBe('disabled');
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  it('returns unconfigured when enabled but no key', async () => {
    const { svc } = build();
    await svc.update({ enabled: true });
    (global as any).fetch = jest.fn();
    const res = await svc.status();
    expect(res.status).toBe('unconfigured');
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  it('resolves the public URL and audits open', async () => {
    const { svc, audit } = build();
    await svc.update({ publicUrl: 'http://localhost:9696', enabled: true });
    const res = await svc.open({ userId: 'u1' });
    expect(res.url).toBe('http://localhost:9696');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'prowlarr.opened' }));
  });
});
