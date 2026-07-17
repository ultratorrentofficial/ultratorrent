import { assertSafeOutboundUrl } from './ssrf';

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  delete process.env.SSRF_ALLOW_HOSTS;
});

describe('assertSafeOutboundUrl', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(assertSafeOutboundUrl('file:///etc/passwd')).rejects.toThrow(/http/);
    await expect(assertSafeOutboundUrl('gopher://x')).rejects.toThrow(/http/);
  });

  it('rejects the cloud metadata IP and localhost', async () => {
    await expect(assertSafeOutboundUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/blocked internal/);
    await expect(assertSafeOutboundUrl('http://127.0.0.1:4000/')).rejects.toThrow(/blocked internal/);
    await expect(assertSafeOutboundUrl('http://[::1]/')).rejects.toThrow(/blocked internal/);
  });

  it('rejects private ranges given as literal IPs', async () => {
    await expect(assertSafeOutboundUrl('http://10.0.0.5/')).rejects.toThrow(/blocked internal/);
    await expect(assertSafeOutboundUrl('http://192.168.1.10/hook')).rejects.toThrow(/blocked internal/);
    await expect(assertSafeOutboundUrl('http://172.16.0.1/')).rejects.toThrow(/blocked internal/);
  });

  it('allows a public IP', async () => {
    const url = await assertSafeOutboundUrl('https://93.184.216.34/x');
    expect(url.hostname).toBe('93.184.216.34');
  });

  it('honours the SSRF_ALLOW_HOSTS opt-out for a trusted internal host', async () => {
    process.env.SSRF_ALLOW_HOSTS = '192.168.99.10';
    const url = await assertSafeOutboundUrl('http://192.168.99.10:8080/hook');
    expect(url.hostname).toBe('192.168.99.10');
  });

  it('rejects an unresolvable/garbage URL', async () => {
    await expect(assertSafeOutboundUrl('not a url')).rejects.toThrow();
  });
});
