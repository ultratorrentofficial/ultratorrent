/**
 * Replace `cid:` image references with inline `data:` URIs, for the in-app
 * preview iframe (which cannot resolve a mail attachment).
 *
 * **One pass over whole tokens.** The obvious implementation — loop the
 * attachments, string-replace each `cid:<id>` — is wrong the moment there are
 * more than ten of them, because `cid:nlposter-1` is a *prefix* of
 * `cid:nlposter-10` … `nlposter-19`. Replacing the short one first rewrites the
 * long ones too, leaving the wrong image plus a stray digit.
 *
 * That is not hypothetical: a live newsletter with 22 posters rendered only 10
 * distinct images, eleven shows sharing one poster. It read as *missing*
 * artwork rather than *wrong* artwork because the duplicated poster was a dark
 * one, and at 84px on a near-black card it looked like an empty cell.
 *
 * Matching `cid:` plus a full run of id characters makes a longer id
 * unmatchable by a shorter one, whatever order the attachments arrive in.
 */
export interface InlineableAttachment {
  cid: string;
  content: Buffer;
  contentType?: string;
}

export function inlineCidImages(html: string, attachments: readonly InlineableAttachment[]): string {
  if (!attachments.length) return html;
  const byCid = new Map(attachments.map((a) => [a.cid, a]));
  // An unknown cid is left untouched rather than blanked: a broken image says
  // "this attachment is missing", while an empty src silently looks fine.
  return html.replace(/cid:([A-Za-z0-9._-]+)/g, (whole, id: string) => {
    const a = byCid.get(id);
    return a ? `data:${a.contentType ?? 'image/jpeg'};base64,${a.content.toString('base64')}` : whole;
  });
}
