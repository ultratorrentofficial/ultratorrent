import { buildPresentation } from './presentation-builders';
import { DOMAIN_EVENTS } from '@ultratorrent/shared';

/**
 * A playback card has to say WHERE the stream is being handled.
 *
 * With Plex and Jellyfin attached to one host, "Dennis started watching The King
 * of Queens" is not actionable — it does not say which server to look at. The
 * product tells Plex from Jellyfin; the server name tells one Plex box from
 * another; a card needs both.
 */
const card = (payload: Record<string, unknown>, canSeeDetail = true) =>
  buildPresentation({
    definition: { presentationBuilder: 'playback' },
    envelope: {
      eventKey: DOMAIN_EVENTS.MEDIA_SERVER_USER_STARTED_WATCHING,
      payload: { mediaTitle: 'Cello, Goodbye', ...payload },
      occurredAt: new Date('2026-09-02T12:00:00Z').toISOString(),
    },
    locale: 'en-US',
    timezone: 'UTC',
    canViewPlaybackDetail: canSeeDetail,
  } as never);

const serverFact = (p: Record<string, unknown>, detail = true) =>
  card(p, detail)?.facts.find((f) => f.label === 'Server');

describe('the playback card names the media server', () => {
  it('gives Jellyfin its product name, marker and server name', () => {
    const f = serverFact({ serverKind: 'jellyfin', serverName: 'SYNOPLEX-JELLYFIN' });
    expect(f?.value).toBe('Jellyfin · SYNOPLEX-JELLYFIN');
    expect(f?.icon).toBe('server');
  });

  it('gives Plex its own colour, so the two are told apart at a glance', () => {
    expect(serverFact({ serverKind: 'plex', serverName: 'SYNOPLEX' })?.value)
      .toBe('Plex · SYNOPLEX');
  });

  it.each([['emby', 'Emby'], ['kodi', 'Kodi']])(
    'covers %s',
    (kind, expected) => {
      expect(serverFact({ serverKind: kind, serverName: 'BOX' })?.value).toBe(`${expected} · BOX`);
    },
  );

  it('is shown even without playback-detail permission — it describes the server, not the viewer', () => {
    expect(serverFact({ serverKind: 'plex', serverName: 'SYNOPLEX' }, false)?.value)
      .toBe('Plex · SYNOPLEX');
  });

  /*
   * No kind is the single-server signal, not missing data: the emitter omits it
   * when only one server is connected, because a tag identical on every card
   * spends a slot to say what the reader already knows.
   */
  it('says nothing when only one server is connected', () => {
    expect(serverFact({ serverName: 'SYNOPLEX' })).toBeUndefined();
  });

  it('shows an unrecognised product verbatim rather than dropping the card', () => {
    expect(serverFact({ serverKind: 'newthing', serverName: 'BOX' })?.value).toBe('newthing · BOX');
  });

  it('omits the row entirely when neither is known', () => {
    expect(serverFact({})).toBeUndefined();
  });
});

import { renderTelegram } from '../providers/telegram-renderer';

/**
 * End to end into the channel that prompted this. The web card has its own icon
 * set; Telegram has emoji, and this is the message a person actually reads.
 */
describe('the Telegram message names the server', () => {
  const message = (kind: string, name: string) =>
    renderTelegram(
      card({
        serverKind: kind,
        serverName: name,
        userDisplayName: 'Dennis Ayala',
        showTitle: 'The King of Queens',
        seasonNumber: 1,
        episodeNumber: 8,
      })!,
    );

  it('puts the product and the server name in the sent text', () => {
    const out = message('jellyfin', 'SYNOPLEX-JELLYFIN');
    expect(out).toContain('Jellyfin');
    expect(out).toContain('SYNOPLEX-JELLYFIN');
    // The playback card is artwork-led: it renders the context line, not the
    // labelled fact rows, so the product name carries the identification alone.
    expect(out).toContain('Jellyfin \u00B7 SYNOPLEX-JELLYFIN');
  });

  it('distinguishes a Plex stream by colour in the same inbox', () => {
    const plex = message('plex', 'SYNOPLEX');
    expect(plex).toContain('Plex · SYNOPLEX');
    expect(plex).not.toContain('Jellyfin');
  });
});
