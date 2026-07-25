import { BadRequestException } from '@nestjs/common';

/**
 * Hosts that may receive a webhook.
 *
 * An allow-list, not a block-list: anything not named here is refused, so a new
 * Discord domain is a deliberate addition rather than an accidental hole.
 */
const ALLOWED_HOSTS = new Set([
  'discord.com',
  'discordapp.com',
  'canary.discord.com',
  'ptb.discord.com',
]);

const WEBHOOK_PATH = /^\/api\/(v\d+\/)?webhooks\/\d+\/[\w-]+\/?$/;

export interface ParsedWebhook {
  /** The URL, normalised. This is what gets encrypted and stored. */
  url: string;
  /** The numeric webhook id from the path, safe to display. */
  webhookId: string;
}

/**
 * Validate a Discord webhook URL.
 *
 * **The allow-list is applied to the host as supplied**, never to a resolved
 * address. A resolve-then-fetch check is defeated by DNS rebinding: the name
 * resolves to something harmless when checked and to `169.254.169.254` when
 * fetched moments later. Pinning the *name* removes the race entirely — there is
 * no window in which the host can change into something else, because we never
 * consult DNS to make the decision.
 *
 * That is the whole SSRF defence, and it is sufficient here precisely because
 * the legitimate destination set is four fixed hostnames. A general-purpose
 * webhook feature would need much more; this one does not have to be general.
 */
export function parseDiscordWebhook(input: string): ParsedWebhook {
  const raw = (input ?? '').trim();
  if (!raw) throw new BadRequestException('A webhook URL is required.');

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException('That is not a valid URL.');
  }

  // Plaintext would send the webhook token — a bearer credential — in the clear.
  if (url.protocol !== 'https:') {
    throw new BadRequestException('The webhook URL must use https.');
  }
  // Credentials in the URL would be forwarded on every send.
  if (url.username || url.password) {
    throw new BadRequestException('The webhook URL must not contain credentials.');
  }
  if (url.port && url.port !== '443') {
    throw new BadRequestException('The webhook URL must not specify a port.');
  }
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new BadRequestException('That is not a Discord webhook URL.');
  }
  if (!WEBHOOK_PATH.test(url.pathname)) {
    throw new BadRequestException('That does not look like a Discord webhook URL.');
  }

  const webhookId = url.pathname.split('/').filter(Boolean).at(-2) ?? '';

  // Rebuilt from parsed parts rather than echoed back, so any query string or
  // fragment a user pasted is dropped rather than stored and replayed.
  return { url: `https://${url.hostname}${url.pathname.replace(/\/$/, '')}`, webhookId };
}

/**
 * What the UI shows instead of the URL.
 *
 * The token is the secret half of a webhook — anyone holding it can post to that
 * channel — so it never appears, not even partially. The id alone is enough for
 * someone to tell two webhooks apart.
 */
export function maskDiscordWebhook(webhookId: string, channelName?: string | null): string {
  const suffix = webhookId.slice(-4);
  return channelName ? `#${channelName} (…${suffix})` : `Webhook …${suffix}`;
}

/**
 * Strip mention triggers from text.
 *
 * Defence in depth. The real protection is `allowed_mentions: { parse: [] }` on
 * every send, which tells Discord to resolve nothing; this also neutralises the
 * literal text so a notification cannot *look* like it is paging a whole server
 * even if that payload field were ever dropped.
 */
export function stripMentions(text: string): string {
  return text
    .replace(/@everyone/gi, '@​everyone')
    .replace(/@here/gi, '@​here')
    // Role and user mentions resolve from raw ids; a zero-width space breaks the
    // token without changing what a human reads.
    .replace(/<@([!&]?)(\d+)>/g, '<@​$1$2>');
}
