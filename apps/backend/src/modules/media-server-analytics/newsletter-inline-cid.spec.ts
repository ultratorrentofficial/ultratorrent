import { inlineCidImages } from './newsletter-inline-cid';

/**
 * The bug these exist for: the preview replaced each `cid:` reference with a
 * separate string-replace pass, so `cid:nlposter-1` also matched the start of
 * `cid:nlposter-10`. A live 22-poster newsletter rendered 10 distinct images —
 * eleven shows sharing one — and because that poster was dark, the cards looked
 * like they had no artwork at all.
 */
const att = (cid: string, body: string, contentType = 'image/jpeg') =>
  ({ cid, content: Buffer.from(body), contentType });

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('inlineCidImages', () => {
  it('does not let a short cid claim a longer one that starts with it', () => {
    const atts = Array.from({ length: 22 }, (_, i) => att(`nlposter-${i}`, `IMAGE${i}`));
    const html = atts.map((a) => `<img src="cid:${a.cid}" />`).join('');

    const out = inlineCidImages(html, atts);

    // Every poster keeps its OWN bytes — the case that regressed.
    for (let i = 0; i < 22; i += 1) {
      expect(out).toContain(`data:image/jpeg;base64,${b64(`IMAGE${i}`)}"`);
    }
    // 22 distinct images, not 10.
    expect(new Set(out.match(/base64,[^"]+/g)).size).toBe(22);
    expect(out).not.toContain('cid:');
  });

  it('leaves no stray digit behind from a partial match', () => {
    const atts = [att('nlposter-1', 'ONE'), att('nlposter-10', 'TEN')];
    const out = inlineCidImages('<img src="cid:nlposter-10" />', atts);
    expect(out).toBe(`<img src="data:image/jpeg;base64,${b64('TEN')}" />`);
  });

  it('honours each attachment content type', () => {
    const out = inlineCidImages(
      '<img src="cid:nlbrandlogo" /><img src="cid:nlposter-0" />',
      [att('nlbrandlogo', 'LOGO', 'image/png'), att('nlposter-0', 'P')],
    );
    expect(out).toContain(`data:image/png;base64,${b64('LOGO')}`);
    expect(out).toContain(`data:image/jpeg;base64,${b64('P')}`);
  });

  it('leaves an unknown cid alone rather than blanking it', () => {
    // A broken image says "attachment missing"; an empty src hides the fault.
    const out = inlineCidImages('<img src="cid:nope" />', [att('nlposter-0', 'P')]);
    expect(out).toBe('<img src="cid:nope" />');
  });

  it('returns the html untouched when there are no attachments', () => {
    expect(inlineCidImages('<img src="cid:x" />', [])).toBe('<img src="cid:x" />');
  });
});
