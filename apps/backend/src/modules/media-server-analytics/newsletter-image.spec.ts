import { NewsletterImageService } from './newsletter-image.service';

/** The signed image URL is the only gate on the public poster endpoint, so its
 * token must verify only for the exact (artworkId, expiry) it was signed with. */
function svc(secret = 'test-secret-value') {
  return new NewsletterImageService({} as any, {} as any, { get: () => secret } as any);
}
const parse = (url: string) => {
  const m = url.match(/nl-image\/([^?]+)\?e=(\d+)&s=([^&]+)/)!;
  return { id: m[1], e: m[2], s: m[3] };
};

describe('NewsletterImageService signed image URLs', () => {
  it('verifies a freshly signed token', () => {
    const s = svc();
    const { id, e, s: sig } = parse(s.imageUrl('http://host', 'art-1'));
    expect(id).toBe('art-1');
    expect(s.verify(id, e, sig)).toBe(true);
  });

  it('rejects a token replayed for a different artwork id', () => {
    const s = svc();
    const { e, s: sig } = parse(s.imageUrl('http://host', 'art-1'));
    expect(s.verify('art-2', e, sig)).toBe(false);
  });

  it('rejects an expired token', () => {
    const s = svc();
    const exp = Date.now() - 1000;
    const sig = (s as any).sign('art-1', exp) as string;
    expect(s.verify('art-1', String(exp), sig)).toBe(false);
  });

  it('rejects a token signed with a different secret', () => {
    const { id, e, s: sig } = parse(svc('secret-a').imageUrl('http://host', 'art-1'));
    expect(svc('secret-b').verify(id, e, sig)).toBe(false);
  });

  it('rejects missing/garbage tokens', () => {
    const s = svc();
    expect(s.verify('art-1', undefined, undefined)).toBe(false);
    expect(s.verify('art-1', 'notanumber', 'x')).toBe(false);
    expect(s.verify('art-1', String(Date.now() + 1000), 'wrongsig')).toBe(false);
  });
});
