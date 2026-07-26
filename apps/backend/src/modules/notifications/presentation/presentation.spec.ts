import {
  DOMAIN_EVENTS,
  avatarFor,
  formatDuration,
  formatEpisodeCode,
  formatMediaLabel,
  hueFor,
  initialsFor,
  isNotificationPresentation,
  splitSummary,
} from '@ultratorrent/shared';
import { getNotificationEvent, allNotificationEvents } from '../notification-catalog';
import {
  buildPresentation,
  hasPresentationBuilder,
  registeredBuilderNames,
  type PresentationContext,
} from './presentation-builders';
import { formatWhen } from './presentation-strings';

function ctx(over: Partial<PresentationContext> = {}): PresentationContext {
  const eventKey = (over.envelope?.eventKey as string) ?? DOMAIN_EVENTS.MEDIA_SERVER_USER_STARTED_WATCHING;
  return {
    definition: getNotificationEvent(eventKey)!,
    envelope: {
      id: 'e1',
      eventKey,
      occurredAt: '2026-07-25T20:24:00Z',
      payload: { mediaTitle: 'Dune', year: 2021, userDisplayName: 'Dennis', serverName: 'Plex' },
    },
    locale: 'en-US',
    timezone: 'UTC',
    canViewPlaybackDetail: true,
    notificationId: 'n1',
    ...over,
  } as PresentationContext;
}

const playback = (payload: Record<string, unknown>, eventKey: string = DOMAIN_EVENTS.MEDIA_SERVER_USER_STARTED_WATCHING, over: Partial<PresentationContext> = {}) =>
  ctx({
    definition: getNotificationEvent(eventKey)!,
    envelope: { id: 'e1', eventKey, occurredAt: '2026-07-25T20:24:00Z', payload },
    ...over,
  });

/* ------------------------------------------------------------------ helpers */

describe('presentation helpers', () => {
  it('derives initials from one or two names', () => {
    expect(initialsFor('Dennis Ayala')).toBe('DA');
    expect(initialsFor('dennis')).toBe('D');
    expect(initialsFor('  Ada  B  Lovelace ')).toBe('AL'); // first + LAST
    expect(initialsFor('   ')).toBe('?');
  });

  it('takes a whole astral character, not half a surrogate pair', () => {
    expect(initialsFor('𝔇ennis')).toBe('𝔇');
    expect(Array.from(initialsFor('🎬 Movie Night'))[0]).toBe('🎬');
  });

  it('gives a stable in-range hue that separates anagrams', () => {
    expect(hueFor('Dennis')).toBe(hueFor('Dennis'));
    expect(hueFor('Dennis')).toBeGreaterThanOrEqual(0);
    expect(hueFor('Dennis')).toBeLessThan(360);
    // A character-sum hash would collide here.
    expect(hueFor('abc')).not.toBe(hueFor('cba'));
  });

  it('returns no avatar when there is no name', () => {
    expect(avatarFor(null)).toBeNull();
    expect(avatarFor('  ')).toBeNull();
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
    // A show with no numbering names the show rather than inventing S00E00.
    expect(formatMediaLabel({ title: 'x', showTitle: 'Severance' })).toBe('Severance');
  });

  it('formats durations with and without hours', () => {
    expect(formatDuration(95)).toBe('1:35');
    expect(formatDuration(4350)).toBe('1:12:30');
    expect(formatDuration(-5)).toBe('0:00');
  });

  it('degrades a summary whose emphasis is absent instead of dropping it', () => {
    expect(splitSummary({ text: 'a Dune b', emphasis: 'Dune' })).toEqual(['a ', 'Dune', ' b']);
    expect(splitSummary({ text: 'a Dune b', emphasis: 'Arrakis' })).toEqual(['a Dune b', '', '']);
    expect(splitSummary({ text: 'plain' })).toEqual(['plain', '', '']);
  });
});

describe('formatWhen', () => {
  const now = new Date('2026-07-25T12:00:00Z');

  it('decides "Today" by calendar date in the recipient zone, not by elapsed hours', () => {
    // 01:00 UTC on the 25th is still the 24th in Puerto Rico (UTC-4).
    expect(formatWhen('2026-07-25T01:00:00Z', 'en-US', 'America/Puerto_Rico', now)).not.toContain('Today');
    expect(formatWhen('2026-07-25T16:00:00Z', 'en-US', 'America/Puerto_Rico', now)).toContain('Today');
  });

  it('falls back to the server zone rather than throwing on a bad stored timezone', () => {
    expect(() => formatWhen('2026-07-25T16:00:00Z', 'en-US', 'Not/AZone', now)).not.toThrow();
  });

  it('returns empty for an unparseable timestamp instead of "Invalid Date"', () => {
    expect(formatWhen('nope', 'en-US', 'UTC', now)).toBe('');
  });
});

/* ------------------------------------------------------------------ playback */

describe('playback: the compact media model', () => {
  const P = { mediaTitle: 'Dune', year: 2021, userDisplayName: 'Dennis', serverName: 'Plex' };

  it('splits a movie into a single titled line', () => {
    const p = buildPresentation(playback(P))!;
    expect(p.media).toEqual({ kind: 'movie', primary: 'Dune (2021)', secondary: null });
  });

  it('splits an episode into series + episode line', () => {
    const p = buildPresentation(playback({
      ...P, mediaTitle: 'The Last of Us — Long Long Time', showTitle: 'The Last of Us',
      episodeTitle: 'Long Long Time', seasonNumber: 1, episodeNumber: 3,
    }))!;
    expect(p.media).toEqual({
      kind: 'episode', primary: 'The Last of Us', secondary: 'S01E03 • Long Long Time',
    });
  });

  it('keeps the episode code when the provider reports no episode name', () => {
    const p = buildPresentation(playback({
      ...P, showTitle: 'The Last of Us', seasonNumber: 1, episodeNumber: 3,
    }))!;
    expect(p.media!.secondary).toBe('S01E03');
  });

  it('treats music as track + artist', () => {
    // Media servers put the artist in the same slot as a show title.
    const p = buildPresentation(playback({
      ...P, mediaTitle: 'Hotel California', showTitle: 'Eagles', mediaType: 'track',
    }))!;
    expect(p.media).toEqual({ kind: 'music', primary: 'Hotel California', secondary: 'Eagles' });
  });

  it('uses listening wording for music, not watching', () => {
    const p = buildPresentation(playback({
      ...P, mediaTitle: 'Hotel California', showTitle: 'Eagles', mediaType: 'track',
    }))!;
    expect(p.summary.text).toContain('started listening to');
  });

  it('summarizes quality as one short line, not a spec sheet', () => {
    const p = buildPresentation(playback({
      ...P, resolution: '4k', videoDynamicRange: 'HDR10',
      device: 'Living Room Apple TV', client: 'Plex for Apple TV',
      playbackMethod: 'transcode', bitrateKbps: 32000,
    }))!;
    expect(p.context).toBe('4K HDR • Living Room Apple TV');
    // The things the old format dumped in.
    expect(p.context).not.toContain('transcode');
    expect(p.context).not.toContain('32000');
  });

  it('normalizes resolutions providers report inconsistently', () => {
    const at = (resolution: string) => buildPresentation(playback({ ...P, resolution }))!.context;
    expect(at('4k')).toBe('4K');
    expect(at('2160')).toBe('4K');
    expect(at('1080')).toBe('1080p');
    expect(at('1080p')).toBe('1080p');
  });

  it('does not claim HDR for an SDR stream', () => {
    const p = buildPresentation(playback({ ...P, resolution: '1080p', videoDynamicRange: 'SDR' }))!;
    expect(p.context).toBe('1080p');
  });

  it('never puts more than two facts on the context line', () => {
    const p = buildPresentation(playback({
      ...P, resolution: '4k', videoDynamicRange: 'HDR10', device: 'Apple TV', progressPercent: 42,
    }))!;
    expect(p.context!.split(' • ')).toHaveLength(2);
  });

  it('calls a part-way start a resume, and leads with the progress', () => {
    const p = buildPresentation(playback({ ...P, progressPercent: 42, device: 'Living Room TV' }))!;
    expect(p.summary.text).toContain('resumed watching');
    expect(p.context).toBe('Resumed at 42% • Living Room TV');
  });

  it('does not call a genuine start a resume', () => {
    // Players report a second or two of offset on a real start.
    const p = buildPresentation(playback({ ...P, progressPercent: 2 }))!;
    expect(p.summary.text).toContain('started watching');
    expect(p.context ?? '').not.toContain('Resumed');
  });

  it('offers exactly one action, pointing at Live Activity', () => {
    const p = buildPresentation(playback(P))!;
    expect(p.action).toEqual({
      label: 'View Live Activity', href: '/media-server-analytics/live', icon: 'monitor',
    });
  });

  /* --------------------------------------------------------------- privacy */

  it('redacts the user identity without the Live Activity permission', () => {
    const p = buildPresentation(playback(P, DOMAIN_EVENTS.MEDIA_SERVER_USER_STARTED_WATCHING, {
      canViewPlaybackDetail: false,
    }))!;
    expect(p.summary.text).toBe('A user started watching Dune (2021)');
    expect(JSON.stringify(p)).not.toContain('Dennis');
  });

  it('redacts device and quality without the permission', () => {
    const p = buildPresentation(playback({
      ...P, resolution: '4k', device: 'Living Room Apple TV',
    }, DOMAIN_EVENTS.MEDIA_SERVER_USER_STARTED_WATCHING, { canViewPlaybackDetail: false }))!;
    expect(p.context).toBeNull();
    expect(JSON.stringify(p)).not.toContain('Living Room');
  });

  it('redacts resume progress too, not just the device', () => {
    // Progress is playback detail like the rest: reporting how far through
    // someone was, while withholding their name, leaks the more personal half.
    const p = buildPresentation(playback({
      ...P, progressPercent: 42, device: 'Living Room Apple TV',
    }, DOMAIN_EVENTS.MEDIA_SERVER_USER_STARTED_WATCHING, { canViewPlaybackDetail: false }))!;
    expect(p.context).toBeNull();
    expect(JSON.stringify(p)).not.toContain('42');
  });

  it('never reads an ip address at any permission level', () => {
    const p = buildPresentation(playback({ ...P, ipAddress: '10.0.0.9' }))!;
    expect(JSON.stringify(p)).not.toContain('10.0.0.9');
  });

  it('translates the compact model too', () => {
    const p = buildPresentation(playback(P, DOMAIN_EVENTS.MEDIA_SERVER_USER_STARTED_WATCHING, {
      locale: 'es-PR',
    }))!;
    expect(p.summary.text).toBe('Dennis comenzó a ver Dune (2021)');
    expect(p.action!.label).toBe('Ver actividad en vivo');
  });

  it('translates the redacted subject as well', () => {
    const p = buildPresentation(playback(P, DOMAIN_EVENTS.MEDIA_SERVER_USER_STARTED_WATCHING, {
      locale: 'es-PR', canViewPlaybackDetail: false,
    }))!;
    expect(p.summary.text).toBe('Un usuario comenzó a ver Dune (2021)');
  });
});

describe('playback: stopped and finished', () => {
  const S = { mediaTitle: 'Dune: Part Two', year: 2024, userDisplayName: 'Dennis', serverName: 'Plex' };
  const stopped = (payload: Record<string, unknown>, over = {}) =>
    buildPresentation(playback({ ...S, ...payload }, DOMAIN_EVENTS.MEDIA_SERVER_USER_STOPPED_WATCHING, over))!;

  it('reads as a sentence, not an event label', () => {
    const p = stopped({ completionPercent: 42, watchedSeconds: 24 * 60 });
    expect(p.summary.text).toBe('Dennis stopped watching Dune: Part Two (2024)');
    expect(p.summary.text).not.toContain('User Stopped');
  });

  it('puts progress and duration on one short line', () => {
    const p = stopped({ completionPercent: 42, watchedSeconds: 24 * 60 });
    expect(p.context).toBe('42% watched • 24 min');
  });

  it('formats an hour-plus session as hours and padded minutes', () => {
    const p = stopped({ completionPercent: 42, watchedSeconds: 69 * 60 });
    expect(p.context).toBe('42% watched • 1h 09m');
  });

  it('says "finished" once the completion threshold is met', () => {
    // The platform's existing threshold, not a second definition of "done".
    const p = stopped({ completionPercent: 95, watchedSeconds: 166 * 60 });
    expect(p.summary.text).toBe('Dennis finished watching Dune: Part Two (2024)');
    expect(p.context).toBe('Completed • 2h 46m');
  });

  it('does not say "finished" just below the threshold', () => {
    const p = stopped({ completionPercent: 89, watchedSeconds: 60 * 60 });
    expect(p.summary.text).toContain('stopped watching');
    expect(p.context).toContain('89% watched');
  });

  it('never claims 0% when progress is unknown', () => {
    const p = stopped({ watchedSeconds: 24 * 60 });
    expect(p.context).toBe('24 min');
    expect(p.context).not.toContain('0%');
  });

  it('falls back to the device only when there is no progress at all', () => {
    const p = stopped({ device: 'Bedroom TV' });
    expect(p.context).toBe('Bedroom TV');
  });

  it('prefers progress over the device when both exist', () => {
    const p = stopped({ completionPercent: 87, device: 'Bedroom TV' });
    expect(p.context).toBe('87% watched');
    expect(p.context).not.toContain('Bedroom');
  });

  it('never puts more than two facts on the line', () => {
    const p = stopped({ completionPercent: 95, watchedSeconds: 3600, device: 'Bedroom TV' });
    expect(p.context!.split(' • ')).toHaveLength(2);
  });

  it('omits a duration too short to be worth reporting', () => {
    const p = stopped({ completionPercent: 3, watchedSeconds: 12 });
    expect(p.context).toBe('3% watched');
  });

  it('renders an episode as series + episode line', () => {
    const p = stopped({
      mediaTitle: 'The Last of Us — Long Long Time', showTitle: 'The Last of Us',
      episodeTitle: 'Long Long Time', seasonNumber: 1, episodeNumber: 3,
      completionPercent: 42, watchedSeconds: 24 * 60,
    });
    expect(p.media).toEqual({
      kind: 'episode', primary: 'The Last of Us', secondary: 'S01E03 • Long Long Time',
    });
    expect(p.context).toBe('42% watched • 24 min');
  });

  it('uses listening wording for a finished album', () => {
    const p = stopped({
      mediaTitle: 'Hotel California', showTitle: 'Eagles', mediaType: 'track',
      completionPercent: 98, watchedSeconds: 40 * 60,
    });
    expect(p.summary.text).toContain('finished listening to');
  });

  it('offers exactly one action', () => {
    const p = stopped({ completionPercent: 42 });
    expect(p.action).toEqual({
      label: 'View activity', href: '/media-server-analytics/watch-history', icon: 'activity',
    });
  });

  /* --------------------------------------------------------------- privacy */

  it('redacts identity and progress together', () => {
    const p = stopped(
      { completionPercent: 42, watchedSeconds: 1440, device: 'Bedroom TV' },
      { canViewPlaybackDetail: false },
    );
    expect(p.summary.text).toBe('A user stopped watching Dune: Part Two (2024)');
    expect(p.context).toBeNull();
    const json = JSON.stringify(p);
    expect(json).not.toContain('Dennis');
    expect(json).not.toContain('Bedroom');
  });

  it('never reads an ip address at any permission level', () => {
    const p = stopped({ completionPercent: 42, ipAddress: '10.0.0.9' });
    expect(JSON.stringify(p)).not.toContain('10.0.0.9');
  });

  /* ---------------------------------------------------------- localization */

  it('translates the stopped caption', () => {
    const p = stopped({ completionPercent: 42, watchedSeconds: 24 * 60 }, { locale: 'es-PR' });
    expect(p.summary.text).toBe('Dennis dejó de ver Dune: Part Two (2024)');
    expect(p.context).toBe('42% visto • 24 min');
  });

  it('translates the completed caption, spacing the duration the Spanish way', () => {
    const p = stopped({ completionPercent: 95, watchedSeconds: 166 * 60 }, { locale: 'es-PR' });
    expect(p.summary.text).toBe('Dennis terminó de ver Dune: Part Two (2024)');
    expect(p.context).toBe('Completado • 2 h 46 min');
  });

  it('translates the redacted subject', () => {
    const p = stopped({ completionPercent: 42 }, { locale: 'es-PR', canViewPlaybackDetail: false });
    expect(p.summary.text).toBe('Un usuario dejó de ver Dune: Part Two (2024)');
  });
});

describe('playback presentation', () => {
  it('builds the started card', () => {
    const p = buildPresentation(playback({ mediaTitle: 'Dune', year: 2021, userDisplayName: 'Dennis' }))!;
    expect(p.accent).toBe('started');
    expect(p.icon).toBe('play');
    expect(p.headline).toEqual({ lead: 'User Started', trail: 'Watching' });
    expect(p.summary.text).toBe('Dennis started watching Dune (2021)');
    expect(p.status).toBe('Now Playing');
    expect(p.progress).toBeNull(); // ~0 on a start card; says nothing
    expect(isNotificationPresentation(p)).toBe(true);
  });

  it('builds the stopped card with progress and watched duration', () => {
    const p = buildPresentation(playback(
      {
        mediaTitle: 'x', showTitle: 'The Last of Us', seasonNumber: 1, episodeNumber: 3,
        userDisplayName: 'Dennis', completionPercent: 42, watchedSeconds: 4350,
      },
      DOMAIN_EVENTS.MEDIA_SERVER_USER_STOPPED_WATCHING,
    ))!;
    expect(p.accent).toBe('stopped');
    expect(p.icon).toBe('stop');
    expect(p.summary.text).toBe('Dennis stopped watching The Last of Us - S01E03');
    expect(p.progress).toMatchObject({ percent: 42 });
    expect(p.facts.some((f) => f.value.includes('1:12:30'))).toBe(true);
  });

  it('uses a stopped accent that is NOT the error accent', () => {
    const stopped = buildPresentation(playback(
      { mediaTitle: 'x', completionPercent: 10 },
      DOMAIN_EVENTS.MEDIA_SERVER_USER_STOPPED_WATCHING,
    ))!;
    // Playback ending is red in the design but it is not a failure.
    expect(stopped.accent).toBe('stopped');
    expect(stopped.accent).not.toBe('error');
  });

  it('reflects paused and buffering states', () => {
    expect(buildPresentation(playback({ mediaTitle: 'x', playbackState: 'paused' }))!.status).toBe('Paused');
    expect(buildPresentation(playback({ mediaTitle: 'x', playbackState: 'buffering' }))!.status).toBe('Buffering');
  });

  it('clamps a nonsense progress value into 0–100', () => {
    const over = buildPresentation(playback({ mediaTitle: 'x', completionPercent: 140 }, DOMAIN_EVENTS.MEDIA_SERVER_USER_STOPPED_WATCHING))!;
    const under = buildPresentation(playback({ mediaTitle: 'x', completionPercent: -5 }, DOMAIN_EVENTS.MEDIA_SERVER_USER_STOPPED_WATCHING))!;
    expect(over.progress!.percent).toBe(100);
    expect(under.progress!.percent).toBe(0);
  });

  it('withholds artwork and device detail without view_live_activity', () => {
    const payload = { mediaTitle: 'Dune', connectionId: 'c1', artPath: '/library/1/thumb', device: 'Apple TV', client: 'Plex', resolution: '1080p' };
    const allowed = buildPresentation(playback(payload, DOMAIN_EVENTS.MEDIA_SERVER_USER_STARTED_WATCHING, { canViewPlaybackDetail: true }))!;
    const denied = buildPresentation(playback(payload, DOMAIN_EVENTS.MEDIA_SERVER_USER_STARTED_WATCHING, { canViewPlaybackDetail: false }))!;

    expect(allowed.artwork).toMatchObject({ kind: 'notification', id: 'n1' });
    expect(allowed.facts.some((f) => f.value.includes('Apple TV'))).toBe(true);

    expect(denied.artwork).toBeNull();
    expect(JSON.stringify(denied)).not.toContain('Apple TV');
    expect(JSON.stringify(denied)).not.toContain('1080p');
  });

  it('omits artwork when there is no notification to proxy it through', () => {
    const p = buildPresentation(playback(
      { mediaTitle: 'Dune', connectionId: 'c1', artPath: '/x' },
      DOMAIN_EVENTS.MEDIA_SERVER_USER_STARTED_WATCHING,
      { notificationId: null },
    ))!;
    expect(p.artwork).toBeNull();
  });

  it('never emits a provider path or URL into the presentation', () => {
    const p = buildPresentation(playback({ mediaTitle: 'Dune', connectionId: 'c1', artPath: '/library/metadata/9/thumb/1' }))!;
    const json = JSON.stringify(p);
    expect(json).not.toContain('/library/metadata');
    expect(json).not.toContain('http');
  });

  it('never renders an IP address, even for a privileged recipient', () => {
    const p = buildPresentation(playback({ mediaTitle: 'Dune', userDisplayName: 'Dennis', ipAddress: '10.220.35.77' }))!;
    expect(JSON.stringify(p)).not.toContain('10.220.35.77');
  });

  it('names an unnamed viewer rather than rendering "undefined"', () => {
    const p = buildPresentation(playback({ mediaTitle: 'Dune' }))!;
    expect(p.summary.text).toBe('Someone started watching Dune');
    expect(p.avatar!.initials).toBe('S');
  });

  it('declines rather than building a titleless card', () => {
    expect(buildPresentation(playback({ userDisplayName: 'Dennis' }))).toBeNull();
    expect(buildPresentation(playback({ mediaTitle: '   ' }))).toBeNull();
  });

  it('translates the whole card, not just the headline', () => {
    const p = buildPresentation(playback(
      { mediaTitle: 'Dune', year: 2021, userDisplayName: 'Dennis' },
      DOMAIN_EVENTS.MEDIA_SERVER_USER_STARTED_WATCHING,
      { locale: 'es-PR' },
    ))!;
    expect(p.headline).toEqual({ lead: 'Usuario comenzó', trail: 'a ver' });
    expect(p.summary.text).toBe('Dennis comenzó a ver Dune (2021)');
    expect(p.status).toBe('Reproduciendo ahora');
    expect(p.facts.map((f) => f.label)).toEqual(expect.arrayContaining(['Usuario', 'Contenido', 'Hora']));
    // One primary action, and it is the Live Activity button.
    expect(p.action!.label).toBe('Ver actividad en vivo');
  });

  it('coerces the numeric strings some providers send', () => {
    const p = buildPresentation(playback(
      { mediaTitle: 'x', showTitle: 'Show', seasonNumber: '2', episodeNumber: '7', completionPercent: '88' },
      DOMAIN_EVENTS.MEDIA_SERVER_USER_STOPPED_WATCHING,
    ))!;
    expect(p.summary.text).toContain('Show - S02E07');
    expect(p.progress!.percent).toBe(88);
  });
});

/* -------------------------------------------------------------- other builders */

describe('other presentation builders', () => {
  const build = (eventKey: string, payload: Record<string, unknown>) =>
    buildPresentation(ctx({
      definition: getNotificationEvent(eventKey)!,
      envelope: { id: 'e', eventKey, occurredAt: '2026-07-25T20:24:00Z', payload },
    }));

  it('renders torrent completed as success and failed as error', () => {
    expect(build(DOMAIN_EVENTS.TORRENT_COMPLETED, { torrentName: 'Dune.2021' })!.accent).toBe('success');
    const failed = build(DOMAIN_EVENTS.TORRENT_FAILED, { torrentName: 'Dune.2021', reason: 'tracker gone' })!;
    expect(failed.accent).toBe('error');
    expect(failed.facts.some((f) => f.value === 'tracker gone')).toBe(true);
  });

  it('escalates storage from warning to error, and shows FREE space on the bar', () => {
    expect(build(DOMAIN_EVENTS.SYSTEM_STORAGE_WARNING, { path: '/mnt/a', freePercent: 12 })!.accent).toBe('warning');
    const critical = build(DOMAIN_EVENTS.SYSTEM_STORAGE_CRITICAL, { path: '/mnt/a', freePercent: 3 })!;
    expect(critical.accent).toBe('error');
    expect(critical.progress!.percent).toBe(3);
    expect(build(DOMAIN_EVENTS.SYSTEM_STORAGE_RECOVERED, { path: '/mnt/a', freePercent: 40 })!.accent).toBe('success');
  });

  it('points a workflow approval at the approvals queue, not the list', () => {
    const p = build(DOMAIN_EVENTS.WORKFLOW_APPROVAL_REQUESTED, { workflowName: 'Nightly', executionId: 'x' })!;
    expect(p.accent).toBe('warning');
    expect(p.action!.href).toBe('/workflows/approvals');
  });

  it('renders provider offline vs recovered', () => {
    expect(build(DOMAIN_EVENTS.PROVIDER_OFFLINE, { providerName: 'qBittorrent' })!.accent).toBe('error');
    expect(build(DOMAIN_EVENTS.PROVIDER_RECOVERED, { providerName: 'qBittorrent' })!.accent).toBe('success');
  });

  it('keeps every security event at least a warning', () => {
    for (const key of [
      DOMAIN_EVENTS.SECURITY_PASSWORD_CHANGED,
      DOMAIN_EVENTS.SECURITY_TWO_FACTOR_DISABLED,
      DOMAIN_EVENTS.SECURITY_API_KEY_CREATED,
      DOMAIN_EVENTS.SECURITY_LOGIN_FAILED,
    ]) {
      expect(build(key, { keyName: 'ci', username: 'dennis' })!.accent).toBe('warning');
    }
  });

  it('declines a builder whose required field is missing', () => {
    expect(build(DOMAIN_EVENTS.TORRENT_COMPLETED, {})).toBeNull();
    expect(build(DOMAIN_EVENTS.SYSTEM_STORAGE_WARNING, { path: '/mnt/a' })).toBeNull();
    expect(build(DOMAIN_EVENTS.WORKFLOW_EXECUTION_FAILED, {})).toBeNull();
  });
});

/* ------------------------------------------------------------------ registry */

describe('presentation registry', () => {
  it('has a builder for every builder name the catalogue references', () => {
    for (const definition of allNotificationEvents()) {
      expect(hasPresentationBuilder(definition.presentationBuilder)).toBe(true);
    }
  });

  it('registers no builder the catalogue never names', () => {
    const used = new Set(allNotificationEvents().map((d) => d.presentationBuilder));
    for (const name of registeredBuilderNames()) {
      expect(used.has(name)).toBe(true);
    }
  });

  it('returns null rather than throwing when a builder blows up', () => {
    const out = buildPresentation(ctx({
      definition: { ...getNotificationEvent(DOMAIN_EVENTS.TORRENT_COMPLETED)!, presentationBuilder: 'nope' },
    }));
    expect(out).toBeNull();
  });

  it('rejects a stored value that is not a presentation', () => {
    expect(isNotificationPresentation(null)).toBe(false);
    expect(isNotificationPresentation({ version: 1, eventKey: 'x' })).toBe(false); // old version
    expect(isNotificationPresentation({ mediaTitle: 'Dune' })).toBe(false);
  });
});
