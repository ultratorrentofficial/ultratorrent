import { BadRequestException } from '@nestjs/common';
import { PublicUrlService } from './public-url.service';

/**
 * The validation is the security-relevant half of this service: the stored value
 * is pasted into links that leave the building, so anything it accepts becomes a
 * URL in a stranger's inbox.
 */
describe('PublicUrlService.normalize', () => {
  const svc = new PublicUrlService({} as never);
  const bad = (input: string) => () => svc.normalize(input);

  it('keeps a non-default port, because it is load-bearing', () => {
    expect(svc.normalize('https://ut.example.net:10443')).toBe('https://ut.example.net:10443');
  });

  it('drops a default port, which is noise', () => {
    expect(svc.normalize('https://ut.example.net:443')).toBe('https://ut.example.net');
    expect(svc.normalize('http://ut.example.net:80')).toBe('http://ut.example.net');
  });

  it('strips a trailing slash so callers can append without doubling it', () => {
    expect(svc.normalize('https://ut.example.net/')).toBe('https://ut.example.net');
  });

  it('trims surrounding whitespace from a pasted value', () => {
    expect(svc.normalize('  https://ut.example.net  ')).toBe('https://ut.example.net');
  });

  it('treats empty as unset rather than an error', () => {
    expect(svc.normalize('')).toBe('');
    expect(svc.normalize('   ')).toBe('');
  });

  it('rejects a path — a base URL that carries one produces broken links', () => {
    expect(bad('https://ut.example.net/app')).toThrow(BadRequestException);
  });

  it('rejects a query or fragment for the same reason', () => {
    expect(bad('https://ut.example.net?a=1')).toThrow(BadRequestException);
    expect(bad('https://ut.example.net#x')).toThrow(BadRequestException);
  });

  it('rejects embedded credentials, which would be mailed out verbatim', () => {
    expect(bad('https://user:pw@ut.example.net')).toThrow(BadRequestException);
  });

  it('rejects a non-http scheme', () => {
    expect(bad('ftp://ut.example.net')).toThrow(BadRequestException);
    expect(bad('javascript:alert(1)')).toThrow(BadRequestException);
  });

  it('rejects something that is not a URL at all', () => {
    expect(bad('ut.example.net')).toThrow(BadRequestException);
    expect(bad('not a url')).toThrow(BadRequestException);
  });
});

describe('PublicUrlService.baseUrl', () => {
  const withStored = (value: unknown) =>
    new PublicUrlService({
      setting: { findUnique: async () => (value === undefined ? null : { value }) },
    } as never);

  it('returns null when unset, so callers omit the link instead of guessing', async () => {
    expect(await withStored(undefined).baseUrl()).toBeNull();
    expect(await withStored({}).baseUrl()).toBeNull();
    expect(await withStored({ url: '' }).baseUrl()).toBeNull();
  });

  it('returns the configured origin', async () => {
    expect(await withStored({ url: 'https://ut.example.net:10443' }).baseUrl()).toBe(
      'https://ut.example.net:10443',
    );
  });
});

describe('PublicUrlService.status when unset', () => {
  it('reports "unset" without attempting any network probe', async () => {
    const svc = new PublicUrlService({ setting: { findUnique: async () => null } } as never);
    const status = await svc.status();
    expect(status.verdict).toBe('unset');
    expect(status.url).toBeNull();
    expect(status.certificate).toBeNull();
  });
});
