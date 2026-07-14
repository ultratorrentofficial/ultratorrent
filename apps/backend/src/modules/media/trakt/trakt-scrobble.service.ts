/**
 * Scrobbling: telling Trakt what is playing, as it plays.
 *
 * Driven by the `MediaServerSession` rows the analytics sweep already maintains,
 * rather than by a second poll of Plex/Jellyfin — one poller, one source of truth
 * about what is on screen.
 *
 * Three things this gets deliberately right, because each has a silent failure
 * mode that ends with someone's Trakt history being wrong:
 *
 * 1. **Transitions, not ticks.** Trakt is told `start` / `pause` / `stop` when the
 *    state CHANGES, not on every poll. Re-sending `start` each minute is how an
 *    application gets throttled.
 * 2. **A vanished session is a stop.** Players do not announce that they stopped;
 *    the session simply disappears. So a session we no longer see is stopped at
 *    its LAST KNOWN progress — and at ≥80% (Trakt's own threshold) that is what
 *    marks the item watched.
 * 3. **Attribution is explicit.** A play arrives attributed to a Plex/Jellyfin
 *    username, which is a different namespace from our users. Only a session whose
 *    username matches an account's `mediaServerUserName` is scrobbled. No match →
 *    no scrobble, because guessing puts one person's viewing in another's history.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { TraktAuthService } from './trakt-auth.service';
import { TraktClient, buildScrobbleBody, type ScrobbleSubject } from './trakt-client';
import { watchKey } from './trakt-sync.service';

/** Trakt marks an item watched when a scrobble stops at or above this progress. */
export const WATCHED_THRESHOLD_PCT = 80;

type ScrobbleAction = 'start' | 'pause';

interface TrackedSession {
  userId: string;
  action: ScrobbleAction;
  progress: number;
  subject: ScrobbleSubject;
}

@Injectable()
export class TraktScrobbleService {
  private readonly logger = new Logger(TraktScrobbleService.name);
  /**
   * What we last told Trakt, per media-server session. In memory on purpose: a
   * restart loses the fact that a scrobble was open, and re-`start`ing a playing
   * session is harmless, whereas a persisted "open scrobble" that never closes is
   * not.
   */
  private readonly tracked = new Map<string, TrackedSession>();
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: TraktAuthService,
  ) {}

  @Interval('trakt_scrobble', 60_000)
  async tick(): Promise<void> {
    if (this.running) return; // a slow Trakt must not overlap the next tick
    this.running = true;
    try {
      await this.sweep();
    } catch (err) {
      this.logger.warn(`Scrobble sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Exposed for tests: one full pass over the current sessions. */
  async sweep(): Promise<void> {
    const accounts = await this.prisma.traktAccount.findMany({
      where: { scrobbleEnabled: true, mediaServerUserName: { not: null } },
    });
    if (!accounts.length) {
      this.tracked.clear();
      return;
    }
    const creds = await this.auth.credentials();
    if (!creds) return;
    const client = new TraktClient(creds);

    const byUserName = new Map(accounts.map((a) => [a.mediaServerUserName!.toLowerCase(), a]));
    const sessions = await this.prisma.mediaServerSession.findMany();
    const seen = new Set<string>();

    for (const session of sessions) {
      const account = session.userName
        ? byUserName.get(session.userName.toLowerCase())
        : undefined;
      if (!account) continue; // not a user who asked us to scrobble for them

      const subject: ScrobbleSubject = {
        mediaType: session.mediaType,
        externalIds: (session.externalIds as Record<string, string> | null) ?? null,
        showTitle: session.showTitle,
        title: session.title,
        seasonNumber: session.seasonNumber,
        episodeNumber: session.episodeNumber,
      };
      const progress = session.progressPercent ?? 0;
      // An item we cannot identify is not scrobbled at all — better a missing
      // entry than the wrong show marked watched.
      if (!buildScrobbleBody(subject, progress)) continue;

      seen.add(session.id);
      const paused = (session.playbackState ?? '').toLowerCase() === 'paused';
      const action: ScrobbleAction = paused ? 'pause' : 'start';
      const prev = this.tracked.get(session.id);

      // Only on a transition: Trakt does not want (and throttles) a heartbeat.
      if (!prev || prev.action !== action) {
        await this.send(client, account.userId, action, subject, progress);
      }
      this.tracked.set(session.id, { userId: account.userId, action, progress, subject });
    }

    // Sessions that vanished since the last sweep: the player stopped and said
    // nothing. Close them at their last known progress.
    for (const [sessionId, state] of [...this.tracked.entries()]) {
      if (seen.has(sessionId)) continue;
      this.tracked.delete(sessionId);
      try {
        await this.send(client, state.userId, 'stop', state.subject, state.progress);
        if (state.progress >= WATCHED_THRESHOLD_PCT) {
          await this.recordWatch(state.userId, state.subject);
        }
      } catch (err) {
        this.logger.warn(`Could not stop scrobble for ${sessionId}: ${(err as Error).message}`);
      }
    }
  }

  private async send(
    client: TraktClient,
    userId: string,
    action: 'start' | 'pause' | 'stop',
    subject: ScrobbleSubject,
    progress: number,
  ): Promise<void> {
    const body = buildScrobbleBody(subject, progress);
    if (!body) return;
    try {
      const token = await this.auth.accessTokenFor(userId);
      await client.post(`/scrobble/${action}`, body, token);
    } catch (err) {
      this.logger.warn(
        `Trakt scrobble ${action} failed for user ${userId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Record the finished play on our side too.
   *
   * Stamped as already synced: Trakt learned about it from the scrobble itself,
   * so the watched-state push must not send it a second time and re-date their
   * history.
   */
  private async recordWatch(userId: string, subject: ScrobbleSubject): Promise<void> {
    const ids = (subject.externalIds ?? {}) as Record<string, string>;
    const identity = {
      imdbId: ids.imdb ?? null,
      tmdbId: ids.tmdb ?? null,
      tvdbId: ids.tvdb ?? null,
      title: subject.title ?? null,
      showTitle: subject.showTitle ?? null,
      season: subject.seasonNumber ?? null,
      episode: subject.episodeNumber ?? null,
    };
    const key = watchKey(identity);
    const now = new Date();
    await this.prisma.mediaUserWatch.upsert({
      where: { userId_key: { userId, key } },
      create: {
        userId,
        key,
        mediaType: identity.season != null ? 'episode' : 'movie',
        imdbId: identity.imdbId,
        tmdbId: identity.tmdbId,
        tvdbId: identity.tvdbId,
        showTitle: identity.showTitle,
        title: identity.title,
        season: identity.season,
        episode: identity.episode,
        watchedAt: now,
        source: 'media_server',
        syncedAt: now, // ← the scrobble already told Trakt; never push it again
      },
      update: { watchedAt: now, syncedAt: now },
    });
  }
}
