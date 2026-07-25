import type { NotificationPresentation } from '@ultratorrent/shared';

/** Supported recipient locales. Anything else falls back to en-US. */
export type PresentationLocale = 'en-US' | 'es-PR';

/**
 * Everything a builder may consider — and nothing more.
 *
 * `canViewLiveActivity` is resolved by the caller and passed in rather than
 * looked up here, so a builder cannot accidentally run without a permission
 * decision having been made: omitting it is a type error, not a silent `false`
 * that would quietly hide artwork, or a silent `true` that would leak it.
 */
export interface PresentationContext {
  eventKey: string;
  payload: Record<string, unknown>;
  locale: PresentationLocale;
  /** IANA zone for rendering times, or null to use the server's. */
  timezone: string | null;
  /** Event time, ISO 8601. */
  at: string;
  /** Whether this recipient may see media-server activity detail (artwork, device). */
  canViewLiveActivity: boolean;
  /**
   * The notification row this presentation belongs to, once it exists.
   *
   * Artwork that outlives the live session is proxied by notification id, so a
   * builder can only emit such a reference when the id is known. Null during a
   * preview, where the card renders without stored artwork.
   */
  notificationId: string | null;
}

/**
 * Builds the presentation for one event, or returns null to decline — in which
 * case the surface falls back to the plain rendered title and body.
 *
 * Returning null rather than throwing is deliberate: a builder that cannot cope
 * with an unexpected payload must degrade the *card*, never the delivery.
 */
export type PresentationBuilder = (ctx: PresentationContext) => NotificationPresentation | null;
