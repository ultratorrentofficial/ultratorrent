import { decodeEntities, htmlToText, stripTags } from './html-text';

/**
 * Provider markup reduced to text.
 *
 * Both defects these cover were live: TVmaze summaries reach the Discover UI and
 * the notification digest, and Plex attributes reach the media-server
 * integration. The consumers escape on render, so this is defence in depth —
 * but a function whose whole job is to remove markup should not be the place
 * that produces some.
 */
describe('stripTags reaches a fixpoint', () => {
  /*
   * Deleting a tag can reveal a tag that was not in the input, so the property
   * asserted is that NO `<…>` sequence survives — not a particular residue.
   * `<scr<script>ipt>` leaves `ipt>`, which carries no `<` and is therefore
   * inert text; pinning the exact leftover would be testing the regex's arithmetic
   * rather than the guarantee anyone depends on.
   */
  it.each([
    '<scr<script>ipt>alert(1)</script>',
    '<<b>b>bold</<b>b>',
    '<<>>text',
    '<scr<scr<b>ipt>ipt>x',
    '<img src=x onerror=alert(1)>',
    '<<<<>>>>',
  ])('leaves nothing markup-shaped in %s', (input) => {
    const out = stripTags(input);
    expect(out).not.toMatch(/<[^>]*>/);
    expect(out).not.toContain('<');
  });

  /* A single pass would leave a tag here; the fixpoint does not. */
  it('is not satisfied by one pass', () => {
    const once = '<scr<script>ipt>x'.replace(/<[^>]*>/g, '');
    expect(once).toContain('ipt>');
    expect(stripTags('<scr<script>ipt>x')).not.toContain('<');
  });

  it('leaves ordinary prose alone', () => {
    expect(stripTags('A show about 3 < 5 maths')).toBe('A show about 3 < 5 maths');
  });

  it('terminates on pathological input rather than looping', () => {
    const start = Date.now();
    stripTags('<'.repeat(20_000));
    expect(Date.now() - start).toBeLessThan(400);
  });
});

describe('decodeEntities decodes exactly one round', () => {
  /*
   * The ordering bug. With `&amp;` decoded first, `&amp;lt;` becomes `&lt;` and
   * the next rule turns it into `<` — a character the provider never sent.
   */
  it('does not double-unescape', () => {
    expect(decodeEntities('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
    expect(decodeEntities('&amp;amp;')).toBe('&amp;');
  });

  it.each([
    ['&lt;b&gt;', '<b>'],
    ['&quot;quoted&quot;', '"quoted"'],
    ['&#39;apos&#39;', "'apos'"],
    ['&apos;x&apos;', "'x'"],
    ['Tom &amp; Jerry', 'Tom & Jerry'],
  ])('decodes %s', (input, expected) => {
    expect(decodeEntities(input)).toBe(expected);
  });
});

describe('htmlToText leaves no markup behind', () => {
  /*
   * The order bug, end to end. Stripping before decoding left `&lt;script&gt;`
   * untouched — it carries no literal `<` — and the entity pass then produced a
   * real `<script>` in the stored value.
   */
  it.each([
    '&lt;script&gt;alert(1)&lt;/script&gt;',
    '&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;',
    '<p>&lt;img src=x onerror=alert(1)&gt;</p>',
    '<scr<script>ipt>alert(1)</script>',
    '&lt;iframe src=javascript:alert(1)&gt;',
  ])('produces no tag from %s', (input) => {
    expect(htmlToText(input)).not.toMatch(/<[^>]*>/);
  });

  /* An ordinary TVmaze summary must still read as prose. */
  it('keeps the text of a real summary', () => {
    const summary = '<p><b>The Terminal List</b> follows a Navy SEAL &amp; his platoon.</p>';
    expect(htmlToText(summary)).toBe('The Terminal List follows a Navy SEAL & his platoon.');
  });

  it('keeps an ampersand that was written as an entity', () => {
    expect(htmlToText('<p>Tom &amp; Jerry</p>')).toBe('Tom & Jerry');
  });

  it('handles an empty or tag-only fragment', () => {
    expect(htmlToText('<p></p>')).toBe('');
    expect(htmlToText('')).toBe('');
  });
});
