import { Logger } from '@nestjs/common';
import { sniffImageMime } from '../../media/media-artwork.service';

/**
 * Telegram's own ceiling for an uploaded photo.
 *
 * Lower than the platform's 10 MB artwork cap on purpose: Telegram rejects a
 * photo over 10 MB outright, and a rejected send costs a whole delivery attempt.
 * Refusing early turns that into a text-only notification, which still arrives.
 */
export const MAX_TELEGRAM_PHOTO_BYTES = 8 * 1024 * 1024;

/** What Telegram will accept as a photo. It cannot render anything else. */
const ACCEPTED = new Set(['image/png', 'image/jpeg', 'image/webp']);

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export interface TelegramPhoto {
  bytes: Buffer;
  filename: string;
  contentType: string;
}

const logger = new Logger('TelegramArtwork');

/**
 * Turn fetched artwork bytes into something safe to upload — or nothing.
 *
 * The type is decided by **magic bytes**, never the server's declared
 * `Content-Type`. The artwork proxy trusts that header today, which is enough to
 * decide whether to stream something to a browser but not enough to hand to
 * Telegram: a media server that mislabels a file would produce a rejected send
 * that costs a delivery attempt and looks like an outage.
 *
 * Returns null rather than throwing for every rejection. A poster is an
 * enhancement; nothing here may prevent the words from arriving.
 */
export function prepareTelegramPhoto(
  artwork: { body: Buffer; contentType: string } | null,
): TelegramPhoto | null {
  if (!artwork || !artwork.body?.length) return null;

  if (artwork.body.length > MAX_TELEGRAM_PHOTO_BYTES) {
    logger.debug(`Artwork too large for Telegram (${artwork.body.length} bytes); sending text only.`);
    return null;
  }

  const sniffed = sniffImageMime(artwork.body);
  if (!sniffed || !ACCEPTED.has(sniffed)) {
    // Includes the case where the header claimed image/png and the bytes are
    // an SVG, an HTML error page, or a truncated download.
    logger.debug(`Artwork is not a Telegram-renderable image (sniffed: ${sniffed ?? 'unknown'}).`);
    return null;
  }

  return {
    bytes: artwork.body,
    // A fixed, non-identifying name. The real path is provider-internal and
    // must never travel to a third party.
    filename: `poster.${EXT[sniffed]}`,
    contentType: sniffed,
  };
}
