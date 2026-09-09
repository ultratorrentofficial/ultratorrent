/**
 * Turning a provider's HTML fragment into plain text.
 *
 * Metadata providers return markup: TVmaze summaries are `<p><b>Title</b> is
 * …</p>`, Plex sends XML attributes with entities in them. What gets stored has
 * to be text, and getting there by hand goes wrong in two specific ways that
 * both appeared in this codebase.
 *
 * **Order.** Stripping tags and then decoding entities un-does the strip.
 * `&lt;script&gt;` carries no literal `<`, so the tag pass leaves it untouched;
 * the entity pass then turns it into a real `<script>`. The function's output
 * contains the markup its name promises to have removed.
 *
 * **One pass.** `replace(/<[^>]*>/g, '')` deletes what it matches, and what is
 * left can be a tag that was not there before: `<scr<script>ipt>` becomes
 * `<script>`. A single pass is not a fixpoint.
 *
 * So this strips, decodes, and strips again — each strip repeated until the
 * string stops changing. A literal `<` written as `&lt;` in prose is lost along
 * the way, which is the right trade for a synopsis: the contract is that no
 * markup survives, and no synopsis needs an angle bracket.
 */

/** Repeat a rewrite until it stops changing the string, or the budget runs out. */
function toFixpoint(input: string, step: (s: string) => string, budget = 8): string {
  let current = input;
  for (let i = 0; i < budget; i++) {
    const next = step(current);
    if (next === current) return current;
    current = next;
  }
  return current;
}

const TAG = /<[^>]*>/g;

/** Every `<…>` sequence removed, including ones revealed by removing another. */
export function stripTags(input: string): string {
  return toFixpoint(input, (s) => s.replace(TAG, ''));
}

/**
 * The handful of entities providers actually emit.
 *
 * `&amp;` is decoded **last**, and that ordering is the whole point: decoded
 * first, `&amp;lt;` becomes `&lt;` and is then decoded again into `<`, which is
 * one round of escaping the author never wrote. Last, it becomes the literal
 * `&lt;` the author did write.
 */
export function decodeEntities(input: string): string {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * An HTML fragment reduced to plain text, with nothing markup-shaped left.
 *
 * The second strip is not redundant: decoding is what can produce a tag that was
 * not in the input.
 */
export function htmlToText(input: string): string {
  return stripTags(decodeEntities(stripTags(input)));
}
