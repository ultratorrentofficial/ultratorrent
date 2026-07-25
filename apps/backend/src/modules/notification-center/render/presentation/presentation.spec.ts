import {
  NOTIFICATION_EVENTS,
  avatarFor,
  formatEpisodeCode,
  formatMediaLabel,
  hueFor,
  initialsFor,
  isNotificationPresentation,
  splitSummary,
} from '@ultratorrent/shared';
import { buildPresentation, hasPresentation, presentableEventKeys } from './presentation-registry';
import { formatWhen } from './presentation-strings';
import type { PresentationContext } from './presentation.types';

const STARTED = NOTIFICATION_EVENTS.MEDIA_SERVER_USER_STARTED_WATCHING;
const FINISHED = NOTIFICATION_EVENTS.MEDIA_SERVER_USER_FINISHED_WATCHING;

function ctx(over: Partial<PresentationContext> = {}): PresentationContext {
  return {
    eventKey: STARTED,
    payload: { mediaTitle: 'Dune', year: 2021, userDisplayName: 'Dennis', startedAt: '2026-07-25T20:24:00Z' },
    locale: 'en-US',
    timezone: 'UTC',
    at: '2026-07-25T20:24:00Z',
    canViewLiveActivity: true,
    notificationId: 'notif-1',
    ...over,
  };
}

describe('presentation helpers', () => {
  it('derives initials from one or two names', () => {
    expect(initialsFor('Dennis Ayala')).toBe('DA');
    expect(initialsFor('dennis')).toBe('D');
    expect(initialsFor('  Ada  B  Lovelace ')).toBe('AL'); // first + LAST word
    expect(initialsFor('   ')).toBe('?');
  });

  it('takes a whole astral character, not half a surrogate pair', () => {
    // `split('')[0]` would return a lone high surrogate here — an invalid string
    // that renders as a replacement glyph.
    expect(initialsFor('𝔇ennis')).toBe('𝔇');
    expect(Array.from(initialsFor('🎬 Movie Night'))[0]).toBe('🎬');
  });

  it('gives a stable, in-range hue and separates anagrams', () => {
    expect(hueFor('Dennis')).toBe(hueFor('Dennis'));
    expect(hueFor('Dennis')).toBeGreaterThanOrEqual(0);
    expect(hueFor('Dennis')).toBeLessThan(360);
    // A character-sum hash would collide here; FNV-1a must not.
    expect(hueFor('abc')).not.toBe(hueFor('cba'));
  });

  it('returns no avatar when there is no name to show', () => {
    expect(avatarFor(null)).toBeNull();
    expect(avatarFor('  ')).toBeNull();
    expect(avatarFor('Dennis')).toEqual({ initials: 'D', hue: hueFor('Dennis'), label: 'Dennis' });
  });

  it('zero-pads episode codes so they sort as text', () => {
    expect(formatEpisodeCode(1, 3)).toBe('S01E03');
    expect(formatEpisodeCode(12, 105)).toBe('S12E105');
  });

  it('formats episodes, films and bare titles differently', () => {
    expect(formatMediaLabel({ title: 'x', showTitle: 'The Last of Us', seasonNumber: 1, episodeNumber: 3 }))
      .toBe('The Last of Us - S01E03');
    expect(formatMediaLabel({ title: 'Dune', year: 2021 })).toBe('Dune (2021)');
    expect(formatMediaLabel({ title: 'Dune' })).toBe('Dune');
    // A show with no numbering still names the show rather than inventing "S00E00".
    expect(formatMediaLabel({ title: 'x', showTitle: 'Severance' })).toBe('Severance');
  });

  it('splits a summary around its emphasis, and degrades when it is absent', () => {
    expect(splitSummary({ text: 'Dennis started watching Dune', emphasis: 'Dune' }))
      .toEqual(['Dennis started watching ', 'Dune', '']);
    // Not found → the whole sentence survives, unemphasized.
    expect(splitSummary({ text: 'Dennis started watching Dune', emphasis: 'Arrakis' }))
      .toEqual(['Dennis started watching Dune', '', '']);
    expect(splitSummary({ text: 'plain' })).toEqual(['plain', '', '']);
  });
});

describe('formatWhen', () => {
  const now = new Date('2026-07-25T12:00:00Z');

  it('says "Today" by calendar date in the recipient zone, not by elapsed hours', () => {
    // 01:00 UTC on the 25th is still the 24th in Puerto Rico (UTC-4). A 24-hour
    // arithmetic window would wrongly call this "Today".
    const out = formatWhen('2026-07-25T01:00:00Z', 'en-US', 'America/Puerto_Rico', now);
    expect(out).not.toContain('Today');
    expect(formatWhen('2026-07-25T16:00:00Z', 'en-US', 'America/Puerto_Rico', now)).toContain('Today');
  });

  it('falls back to the server zone rather than throwing on a bad stored timezone', () => {
    expect(() => formatWhen('2026-07-25T16:00:00Z', 'en-US', 'Not/AZone', now)).not.toThrow();
    expect(formatWhen('2026-07-25T16:00:00Z', 'en-US', 'Not/AZone', now)).not.toBe('');
  });

  it('returns empty for an unparseable timestamp instead of "Invalid Date"', () => {
    expect(formatWhen('not-a-date', 'en-US', 'UTC', now)).toBe('');
  });
});

describe('playback presentation builder', () => {
  it('registers exactly the two events that have producers', () => {
    expect(presentableEventKeys()).toEqual([FINISHED, STARTED].sort());
    expect(hasPresentation(STARTED)).toBe(true);
    // `media_server.user_stopped` has no producer; registering it would build a
    // card that can never render.
    expect(hasPresentation('media_server.user_stopped')).toBe(false);
    expect(hasPresentation('system.disk_space_low')).toBe(false);
  });

  it('builds the started card: positive accent, now-playing, no progress', () => {
    const p = buildPresentation(ctx())!;
    expect(p.accent).toBe('positive');
    expect(p.icon).toBe('play');
    expect(p.headline).toEqual({ lead: 'User Started', trail: 'Watching' });
    expect(p.summary.text).toBe('Dennis started watching Dune (2021)');
    expect(p.summary.emphasis).toBe('Dune (2021)');
    expect(p.status).toBe('Now playing');
    expect(p.action).toMatchObject({ href: '/media-server/live', icon: 'monitor' });
    // Progress on a start card is always ~0 and says nothing.
    expect(p.progress).toBeNull();
    expect(p.facts.map((f) => f.label)).toEqual(['User', 'Media', 'Time']);
    expect(isNotificationPresentation(p)).toBe(true);
  });

  it('builds the stopped card: negative accent, episode label, progress fact', () => {
    const p = buildPresentation(ctx({
      eventKey: FINISHED,
      payload: {
        mediaTitle: 'The Last of Us — Long Long Time',
        showTitle: 'The Last of Us', seasonNumber: 1, episodeNumber: 3,
        userDisplayName: 'Dennis', completionPercent: 42, stoppedAt: '2026-07-25T20:45:00Z',
      },
    }))!;
    expect(p.accent).toBe('negative');
    expect(p.icon).toBe('stop');
    expect(p.headline.lead).toBe('User Stopped');
    expect(p.summary.text).toBe('Dennis stopped watching The Last of Us - S01E03');
    expect(p.progress).toEqual({ percent: 42, label: '42% watched' });
    expect(p.facts.map((f) => f.label)).toEqual(['User', 'Episode', 'Time', 'Progress']);
    expect(p.facts.find((f) => f.label === 'Episode')!.value).toBe('The Last of Us - S01E03');
    expect(p.action).toMatchObject({ href: '/media-server/history', icon: 'activity' });
  });

  it('clamps a nonsense progress value into 0–100', () => {
    const over = buildPresentation(ctx({ eventKey: FINISHED, payload: { mediaTitle: 'x', completionPercent: 140 } }))!;
    expect(over.progress!.percent).toBe(100);
    const under = buildPresentation(ctx({ eventKey: FINISHED, payload: { mediaTitle: 'x', completionPercent: -5 } }))!;
    expect(under.progress!.percent).toBe(0);
  });

  it('withholds artwork from a recipient without view_live_activity', () => {
    const payload = { mediaTitle: 'Dune', connectionId: 'conn-1', artPath: '/library/1/thumb' };
    expect(buildPresentation(ctx({ payload, canViewLiveActivity: true }))!.artwork)
      .toEqual({ kind: 'notification', id: 'notif-1', aspect: 'poster', alt: 'Poster for Dune' });
    expect(buildPresentation(ctx({ payload, canViewLiveActivity: false }))!.artwork).toBeNull();
  });

  it('omits artwork when there is no notification to proxy it through', () => {
    // A preview has no stored row, so there is no id the proxy could resolve.
    const p = buildPresentation(ctx({
      payload: { mediaTitle: 'Dune', connectionId: 'conn-1', artPath: '/library/1/thumb' },
      notificationId: null,
    }))!;
    expect(p.artwork).toBeNull();
  });

  it('never emits a URL or a provider path into the presentation', () => {
    const p = buildPresentation(ctx({
      payload: { mediaTitle: 'Dune', connectionId: 'conn-1', artPath: '/library/metadata/9/thumb/1' },
    }))!;
    const json = JSON.stringify(p);
    expect(json).not.toContain('/library/metadata');
    expect(json).not.toContain('http');
  });

  it('never renders an IP address, even for a privileged recipient', () => {
    const p = buildPresentation(ctx({
      payload: { mediaTitle: 'Dune', userDisplayName: 'Dennis', ipAddress: '10.220.35.77' },
      canViewLiveActivity: true,
    }))!;
    expect(JSON.stringify(p)).not.toContain('10.220.35.77');
  });

  it('names an unnamed viewer rather than rendering "undefined"', () => {
    const p = buildPresentation(ctx({ payload: { mediaTitle: 'Dune' } }))!;
    expect(p.summary.text).toBe('Someone started watching Dune');
    expect(p.avatar!.initials).toBe('S');
  });

  it('declines rather than building a titleless card', () => {
    expect(buildPresentation(ctx({ payload: { userDisplayName: 'Dennis' } }))).toBeNull();
    expect(buildPresentation(ctx({ payload: { mediaTitle: '   ' } }))).toBeNull();
  });

  it('translates the whole card, not just its headline', () => {
    const p = buildPresentation(ctx({
      locale: 'es-PR',
      payload: { mediaTitle: 'Dune', year: 2021, userDisplayName: 'Dennis' },
    }))!;
    expect(p.headline).toEqual({ lead: 'Usuario comenzó', trail: 'a ver' });
    expect(p.summary.text).toBe('Dennis comenzó a ver Dune (2021)');
    expect(p.status).toBe('Reproduciendo ahora');
    expect(p.facts.map((f) => f.label)).toEqual(['Usuario', 'Contenido', 'Hora']);
    expect(p.action!.label).toBe('Ver detalles');
  });

  it('coerces the numeric strings some providers send', () => {
    const p = buildPresentation(ctx({
      eventKey: FINISHED,
      payload: { mediaTitle: 'x', showTitle: 'Show', seasonNumber: '2', episodeNumber: '7', completionPercent: '88' },
    }))!;
    expect(p.summary.text).toContain('Show - S02E07');
    expect(p.progress).toEqual({ percent: 88, label: '88% watched' });
  });

  it('returns null for an unregistered event instead of throwing', () => {
    expect(buildPresentation(ctx({ eventKey: 'system.disk_space_low' }))).toBeNull();
  });

  it('rejects a stored value that is not a presentation', () => {
    expect(isNotificationPresentation(null)).toBe(false);
    expect(isNotificationPresentation({ version: 99, eventKey: 'x' })).toBe(false);
    expect(isNotificationPresentation({ mediaTitle: 'Dune' })).toBe(false);
  });
});
