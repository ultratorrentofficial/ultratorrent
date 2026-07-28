/**
 * The artwork image route must not sit under the global rate limit.
 *
 * Reported as "a lot of movies have no artwork poster" while the files were on
 * disk, the rows were correct and the endpoint returned real bytes. The cause
 * was the global throttle: `ttl 60s / limit 120`, applied to every route as an
 * APP_GUARD. Each poster tile is its own request, so one screen of the Library
 * Browser is ~45 of them — scrolling a 3 241-item library exhausted the bucket
 * in seconds and every later poster came back 429.
 *
 * Verified in a browser against the live library: 65 artwork responses failed,
 * all `ThrottlerException: Too Many Requests`, and the rendered tile count fell
 * from 45 to 7 as the grid scrolled.
 */
import 'reflect-metadata';
import { MediaController } from './media.controller';

/*
 * The literal metadata keys `@Throttle` writes. `@nestjs/throttler` does not
 * export its constants from the package root, and it suffixes each key with the
 * throttler name — so the stored keys are `THROTTLER:LIMITdefault` and
 * `THROTTLER:TTLdefault`. Matched by prefix so a second named throttler would
 * still be found.
 */
const LIMIT_KEY = 'THROTTLER:LIMIT';
const TTL_KEY = 'THROTTLER:TTL';

function throttleOptions(handlerName: string): { limit?: number; ttl?: number } {
  const proto = MediaController.prototype as unknown as Record<string, unknown>;
  const handler = proto[handlerName];
  const found: { limit?: number; ttl?: number } = {};
  for (const key of Reflect.getMetadataKeys(handler as object)) {
    const k = String(key);
    if (k.startsWith(LIMIT_KEY)) found.limit = Reflect.getMetadata(key, handler as object);
    if (k.startsWith(TTL_KEY)) found.ttl = Reflect.getMetadata(key, handler as object);
  }
  return found;
}

/** The global default every route inherits without an override. */
const GLOBAL_LIMIT = 120;

describe('artwork image rate limit', () => {
  it('is raised well above the global default', () => {
    const { limit } = throttleOptions('artworkImage');
    expect(limit).toBeDefined();
    // A grid screen is ~45 posters; a user scrolling briskly issues several
    // hundred a minute, all of them legitimate reads of their own files.
    expect(limit as number).toBeGreaterThan(GLOBAL_LIMIT * 5);
  });

  it('is still bounded rather than unlimited', () => {
    // Responses are cached for a day, so heavy browsing settles quickly. An
    // unbounded image route would be worth avoiding even so.
    const { limit } = throttleOptions('artworkImage');
    expect(Number.isFinite(limit as number)).toBe(true);
    expect(limit as number).toBeLessThanOrEqual(5000);
  });

  it('keeps a one-minute window, so the limit means what it reads', () => {
    const { ttl } = throttleOptions('artworkImage');
    expect(ttl).toBe(60_000);
  });

  it('leaves the expensive IMDb search route strict', () => {
    // The raise must be scoped to image serving. A search route that hits an
    // external provider has the opposite requirement.
    const { limit } = throttleOptions('imdbSearch');
    if (limit !== undefined) expect(limit).toBeLessThanOrEqual(GLOBAL_LIMIT);
  });
});
