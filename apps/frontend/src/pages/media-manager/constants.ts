import type {
  MediaItemType,
  MediaKind,
  MediaMatchStatus,
  Preset,
  RenameMode,
} from '@/lib/api';

/** Library kinds — mirrors the backend `MediaLibrary.kind` enum. */
export const LIBRARY_KIND_OPTIONS: { value: MediaKind; label: string }[] = [
  { value: 'tv', label: 'TV' },
  { value: 'anime', label: 'Anime' },
  { value: 'movie', label: 'Movie' },
  { value: 'music', label: 'Music' },
  { value: 'audiobook', label: 'Audiobook' },
  { value: 'general', label: 'General' },
];

export const PRESET_OPTIONS: { value: Preset; label: string }[] = [
  { value: 'plex', label: 'Plex' },
  { value: 'jellyfin', label: 'Jellyfin' },
  { value: 'emby', label: 'Emby' },
  { value: 'kodi', label: 'Kodi' },
  { value: 'custom', label: 'Custom' },
];

export const MODE_OPTIONS: { value: RenameMode; label: string }[] = [
  { value: 'preview', label: 'Preview only' },
  { value: 'rename_in_place', label: 'Rename in place' },
  { value: 'rename_move', label: 'Rename + move' },
  { value: 'copy', label: 'Copy' },
  { value: 'hardlink', label: 'Hardlink (keeps seeding)' },
  { value: 'symlink', label: 'Symlink (keeps seeding)' },
];

/** Media item types — mirrors the backend `MediaItem.mediaType` enum. */
export const MEDIA_TYPE_OPTIONS: { value: MediaItemType; label: string }[] = [
  { value: 'movie', label: 'Movie' },
  { value: 'tv', label: 'TV' },
  { value: 'anime', label: 'Anime' },
  { value: 'music_video', label: 'Music video' },
  { value: 'documentary', label: 'Documentary' },
  { value: 'other_video', label: 'Other' },
];

export const MATCH_STATUS_OPTIONS: { value: MediaMatchStatus; label: string }[] = [
  { value: 'matched', label: 'Matched' },
  { value: 'manual', label: 'Manual' },
  { value: 'unmatched', label: 'Unmatched' },
];

export function kindLabel(kind: string): string {
  return LIBRARY_KIND_OPTIONS.find((k) => k.value === kind)?.label ?? kind;
}
export function presetLabel(preset: string): string {
  return PRESET_OPTIONS.find((p) => p.value === preset)?.label ?? preset;
}
export function modeLabel(mode: string): string {
  return MODE_OPTIONS.find((m) => m.value === mode)?.label ?? mode;
}
export function mediaTypeLabel(type: string): string {
  return MEDIA_TYPE_OPTIONS.find((t) => t.value === type)?.label ?? type;
}

/** Colored badge variant for a media item's match status. */
export function matchStatusVariant(
  status: string,
): 'success' | 'info' | 'warning' | 'secondary' {
  switch (status) {
    case 'matched':
      return 'success';
    case 'manual':
      return 'info';
    case 'unmatched':
      return 'warning';
    default:
      return 'secondary';
  }
}

export function matchStatusLabel(status: string): string {
  return MATCH_STATUS_OPTIONS.find((s) => s.value === status)?.label ?? status;
}

/** Artwork types tracked per item — mirrors the backend `ARTWORK_TYPES`. */
export const ARTWORK_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'poster', label: 'Poster' },
  { value: 'fanart', label: 'Fanart' },
  { value: 'logo', label: 'Logo' },
  { value: 'clearart', label: 'Clear art' },
  { value: 'banner', label: 'Banner' },
  { value: 'thumbnail', label: 'Thumbnail' },
  { value: 'season_poster', label: 'Season poster' },
  { value: 'episode_thumbnail', label: 'Episode thumbnail' },
];

export function artworkTypeLabel(type: string): string {
  return ARTWORK_TYPE_OPTIONS.find((t) => t.value === type)?.label ?? type;
}

/** Media-server integration kinds — mirrors the backend `VALID_KINDS`. */
export const MEDIA_SERVER_KIND_OPTIONS: { value: string; label: string }[] = [
  { value: 'plex', label: 'Plex' },
  { value: 'jellyfin', label: 'Jellyfin' },
  { value: 'emby', label: 'Emby' },
  { value: 'kodi', label: 'Kodi' },
];

export function mediaServerKindLabel(kind: string): string {
  return MEDIA_SERVER_KIND_OPTIONS.find((k) => k.value === kind)?.label ?? kind;
}

/** Human labels for duplicate-detection reasons. */
export function duplicateReasonLabel(reason: string): string {
  switch (reason) {
    case 'external_id':
      return 'Same external ID';
    case 'show_season_episode':
      return 'Same show / season / episode';
    case 'title_year':
      return 'Same title & year';
    case 'similar_filename':
      return 'Similar filename';
    default:
      return reason;
  }
}

/** Format a Season/Episode marker from optional numbers. */
export function seasonEpisodeLabel(
  season: number | null | undefined,
  episode: number | null | undefined,
): string {
  if (season == null && episode == null) return '—';
  const s = season != null ? `S${String(season).padStart(2, '0')}` : '';
  const e = episode != null ? `E${String(episode).padStart(2, '0')}` : '';
  return `${s}${e}` || '—';
}
