import { BadRequestException, Injectable } from '@nestjs/common';
import { parseDiscordWebhook } from '../../modules/notifications/channels/discord-validators';

const TIMEOUT_MS = 10_000;

/** What Discord reports about a webhook, for display. */
export interface WebhookInfo {
  channelName: string | null;
  guildId: string | null;
}

/**
 * Posts to personal Discord webhooks.
 *
 * Unlike email and Telegram there is **no shared platform credential**: a
 * webhook URL is itself the destination *and* the authorisation, supplied by
 * each user. So there is nothing for an operator to configure, and nothing this
 * service holds beyond the request it is making.
 *
 * Every URL is re-validated here, not merely at the point it was stored. A
 * stored value could have been written before a validation rule tightened, or by
 * a future code path that forgot to check — re-parsing at send time means the
 * allow-list cannot be bypassed by anything that manages to persist a row.
 */
@Injectable()
export class DiscordTransportService {
  /** Post a rendered payload. Re-validates the URL before touching the network. */
  async send(webhookUrl: string, payload: Record<string, unknown>): Promise<void> {
    const { url } = parseDiscordWebhook(webhookUrl);
    await this.post(url, payload);
  }

  /**
   * Read a webhook's metadata, which doubles as proof it exists.
   *
   * A GET on the webhook URL returns its channel, so connecting can show
   * "#alerts" instead of an opaque id — and a 404 here is how a revoked or
   * mistyped webhook is caught at setup rather than at the first real
   * notification.
   */
  async describe(webhookUrl: string): Promise<WebhookInfo> {
    const { url } = parseDiscordWebhook(webhookUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'GET', redirect: 'error', signal: controller.signal });
      if (!res.ok) throw new BadRequestException('Discord rejected that webhook.');
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return {
        channelName: typeof json.name === 'string' ? json.name : null,
        guildId: typeof json.guild_id === 'string' ? json.guild_id : null,
      };
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new BadRequestException('Discord did not respond in time.');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async post(url: string, payload: Record<string, unknown>): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        // A redirect could carry the request off the allow-listed host, which is
        // exactly what the allow-list exists to prevent.
        redirect: 'error',
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // Discord's own message names the cause ("Unknown Webhook"), which is far
        // more useful than a status code — but the URL is never echoed back,
        // because an error string reaches logs and bug reports.
        throw new BadRequestException(
          `Discord rejected the message (${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`,
        );
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new BadRequestException('Discord did not respond in time.');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
