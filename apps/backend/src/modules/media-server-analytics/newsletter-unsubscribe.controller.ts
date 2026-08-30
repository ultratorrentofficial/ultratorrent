import { Controller, Get, Post, Query, Header } from '@nestjs/common';

import { NewsletterUnsubscribeService, type UnsubscribeOutcome } from './newsletter-unsubscribe.service';

/**
 * Public, unauthenticated unsubscribe. A recipient is not a user of this app and
 * has no session; the signed token in the URL is the whole credential, and it
 * only ever identifies one address on one newsletter.
 *
 * # GET shows, POST acts — and that is not pedantry
 *
 * Mail scanners fetch every link in a message. Outlook's Safe Links, Gmail's
 * prefetcher and most corporate filters issue a GET before a human sees the
 * mail. If GET performed the unsubscribe, recipients would be removed from the
 * list by their own employer's spam filter, silently, and the first anyone would
 * know is that the newsletter stopped arriving.
 *
 * So GET renders a page with a button, and only the POST behind that button
 * changes anything.
 */
@Controller('media-server-analytics/nl-unsubscribe')
export class NewsletterUnsubscribeController {
  constructor(private readonly unsub: NewsletterUnsubscribeService) {}

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  // Told not to index: this URL contains a token that identifies one person.
  @Header('X-Robots-Tag', 'noindex, nofollow')
  async confirm(@Query('t') token?: string): Promise<string> {
    return page(await this.unsub.describe(token), token, false);
  }

  @Post()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  async act(@Query('t') token?: string): Promise<string> {
    return page(await this.unsub.unsubscribe(token), token, true);
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/**
 * One self-contained page, no assets.
 *
 * This is opened from a mail client on an unknown device, often before the app
 * itself has ever been visited, so it links to nothing and loads nothing. It
 * also renders the same whether the address was on the list or not, so the page
 * cannot be used to test whether a given person subscribes.
 */
function page(result: UnsubscribeOutcome, token: string | undefined, done: boolean): string {
  const shell = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#f5f6f7; color:#16191c;
         font:400 15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif; }
  @media (prefers-color-scheme: dark) { body { background:#121619; color:#e6eaec; } }
  .card { max-width:32rem; margin:1.5rem; padding:1.75rem 2rem; border-radius:10px;
          background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.08); }
  @media (prefers-color-scheme: dark) { .card { background:#1a1f23; box-shadow:none;
          border:1px solid #2a3238; } }
  h1 { margin:0 0 .5rem; font-size:1.25rem; font-weight:600; }
  p { margin:.5rem 0; }
  .muted { color:#5d6a72; font-size:.9rem; }
  @media (prefers-color-scheme: dark) { .muted { color:#93a1a8; } }
  button { margin-top:1.25rem; padding:.6rem 1.1rem; font:inherit; font-weight:600;
           color:#fff; background:#b3401f; border:0; border-radius:6px; cursor:pointer; }
  button:hover { background:#96351a; }
  button:focus-visible { outline:2px solid #b3401f; outline-offset:2px; }
</style></head>
<body><div class="card">${body}</div></body></html>`;

  if (!result.ok) {
    return shell('Link not recognised', `
      <h1>This link is not valid</h1>
      <p class="muted">It may have been altered in transit, or the newsletter it
      belonged to no longer exists. Nothing has been changed.</p>`);
  }

  if (done || result.alreadyGone) {
    return shell('Unsubscribed', `
      <h1>You have been unsubscribed</h1>
      <p><strong>${esc(result.email)}</strong> will no longer receive
      &ldquo;${esc(result.newsletterName)}&rdquo;.</p>
      <p class="muted">This only affects that newsletter. Nothing else about your
      account has changed.</p>`);
  }

  return shell('Unsubscribe', `
    <h1>Unsubscribe from &ldquo;${esc(result.newsletterName)}&rdquo;?</h1>
    <p><strong>${esc(result.email)}</strong> will stop receiving it.</p>
    <form method="post" action="?t=${esc(token ?? '')}">
      <button type="submit">Unsubscribe</button>
    </form>
    <p class="muted">Nothing changes until you press the button &mdash; mail
    scanners often open links before you do.</p>`);
}
