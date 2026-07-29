/**
 * Who the newsletter says it is.
 *
 * Two separate requests, one file: the operator names the newsletter their
 * recipients see ("SYNOPLEX Newsletter", not ULTRATORRENT), and the footer
 * credits the software with its REAL version, linked to the source repo. The
 * version had been a hardcoded `'0.15.0'` in the service since that release.
 */
import { buildContent, renderHtml, type RenderOptions } from './newsletter-render';
import { newsletterStrings } from './newsletter-strings';

const now = new Date('2026-07-29T12:00:00Z');
const item = {
  id: 'm1', title: 'The Lantern Problem', mediaType: 'movie', year: 2023, addedAt: now,
  overview: 'A lighthouse keeper counts the ships that never arrive.', rating: 7.8, runtime: 108,
};

function html(over: Partial<RenderOptions> = {}) {
  const content = buildContent([item] as never, new Date('2026-07-22T00:00:00Z'), now);
  return renderHtml(content, {
    strings: newsletterStrings('en-US'), version: '0.57.6', ...over,
  } as RenderOptions);
}

describe('newsletter header title', () => {
  it('uses the product title when the newsletter has none', () => {
    expect(html()).toContain('ULTRATORRENT NEWSLETTER');
  });

  it('uses the operator title when one is set', () => {
    const out = html({ brandTitle: 'SYNOPLEX Newsletter' });
    expect(out).toContain('SYNOPLEX Newsletter');
    expect(out).not.toContain('ULTRATORRENT NEWSLETTER');
  });

  it('falls back for null, empty and whitespace alike', () => {
    // The field is optional in the UI; "blank" must mean the default, never an
    // empty header.
    for (const v of [null, '', '   ']) {
      expect(html({ brandTitle: v })).toContain('ULTRATORRENT NEWSLETTER');
    }
  });

  it('escapes an operator title', () => {
    // Operator-supplied text going into an email.
    const out = html({ brandTitle: '<script>alert(1)</script>' });
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('leaves the footer product credit alone', () => {
    // Renaming the newsletter must not rename the software.
    expect(html({ brandTitle: 'SYNOPLEX Newsletter' })).toContain('UltraTorrent');
  });
});

describe('footer product credit', () => {
  const SRC = 'https://github.com/damirabal/ultratorrent-core';

  it('reads "Powered by <brand> v<version>"', () => {
    expect(html({ sourceUrl: SRC })).toContain('Powered by UltraTorrent v0.57.6');
  });

  it('renders whatever version it is handed, with no literal of its own', () => {
    // The defect was a constant that outlived forty releases; this fails if any
    // version string is ever baked into the template again.
    const out = html({ version: '1.2.3', sourceUrl: SRC });
    expect(out).toContain('v1.2.3');
    expect(out).not.toContain('0.15.0');
  });

  it('links the credit to the source repository', () => {
    expect(html({ sourceUrl: SRC })).toContain(`<a href="${SRC}"`);
  });

  it('still renders the credit as text when no repo url is supplied', () => {
    const out = html();
    expect(out).toContain('Powered by UltraTorrent v0.57.6');
    expect(out).not.toContain('<a href="undefined"');
  });
});
