import type { Namespace, TFunction } from 'i18next';
import type {
  MediaItemType,
  MediaKind,
  MediaMatchStatus,
  Preset,
  RenameMode,
} from '@/lib/api';

/**
 * i18n note: the label/option helpers below translate at RENDER time. They take
 * the caller's `t` (from `useTranslation('media')` / `useTranslation('imdb')`)
 * and resolve namespace-qualified keys. The dynamic-key cast is contained here —
 * the `media`/`imdb` resources hold the canonical enum labels. This mirrors the
 * `tNav` pattern in `components/layout/navigation.ts`.
 */
type AnyT = (key: string, options?: Record<string, unknown>) => string;
/** Accept any namespace's `t` and resolve namespace-qualified keys dynamically. */
type SomeT = TFunction<Namespace>;
const loose = (t: SomeT): AnyT => t as unknown as AnyT;

/** Enum value lists — mirror the backend enums (used to build <Select> options). */
export const LIBRARY_KIND_VALUES: MediaKind[] = [
  'tv',
  'anime',
  'movie',
  'music',
  'audiobook',
  'general',
];

export const PRESET_VALUES: Preset[] = ['plex', 'jellyfin', 'emby', 'kodi', 'custom'];

export const MODE_VALUES: RenameMode[] = [
  'preview',
  'rename_in_place',
  'rename_move',
  'copy',
  'hardlink',
  'symlink',
];

export const MEDIA_TYPE_VALUES: MediaItemType[] = [
  'movie',
  'tv',
  'anime',
  'music_video',
  'documentary',
  'other_video',
];

export const MATCH_STATUS_VALUES: MediaMatchStatus[] = ['matched', 'manual', 'unmatched'];

/** Artwork types tracked per item — mirrors the backend `ARTWORK_TYPES`. */
export const ARTWORK_TYPE_VALUES: string[] = [
  'poster',
  'fanart',
  'logo',
  'clearart',
  'banner',
  'thumbnail',
  'season_poster',
  'episode_thumbnail',
];

/** Media-server integration kinds — mirrors the backend `VALID_KINDS`. */
export const MEDIA_SERVER_KIND_VALUES: string[] = ['plex', 'jellyfin', 'emby', 'kodi'];

/** IMDb operating modes — mirrors the backend `ImdbMode`. */
export const IMDB_MODE_VALUES: string[] = ['disabled', 'dataset', 'official_api', 'hybrid'];

/** IMDb title kinds accepted by search — mirrors the backend `ImdbTitleKind`. */
export const IMDB_TITLE_KIND_VALUES: string[] = ['any', 'movie', 'tv', 'episode'];

// --- Enum label resolvers ---------------------------------------------------

export function kindLabel(t: SomeT, kind: string): string {
  return loose(t)(`media:libraryKind.${kind}`, { defaultValue: kind });
}
export function presetLabel(t: SomeT, preset: string): string {
  return loose(t)(`media:preset.${preset}`, { defaultValue: preset });
}
export function modeLabel(t: SomeT, mode: string): string {
  return loose(t)(`media:renameMode.${mode}`, { defaultValue: mode });
}
export function mediaTypeLabel(t: SomeT, type: string): string {
  return loose(t)(`media:mediaType.${type}`, { defaultValue: type });
}
export function matchStatusLabel(t: SomeT, status: string): string {
  return loose(t)(`media:matchStatus.${status}`, { defaultValue: status });
}
export function artworkTypeLabel(t: SomeT, type: string): string {
  return loose(t)(`media:artworkType.${type}`, { defaultValue: type });
}
export function mediaServerKindLabel(t: SomeT, kind: string): string {
  return loose(t)(`media:mediaServerKind.${kind}`, { defaultValue: kind });
}
export function duplicateReasonLabel(t: SomeT, reason: string): string {
  return loose(t)(`media:duplicateReason.${reason}`, { defaultValue: reason });
}
export function imdbModeLabel(t: SomeT, mode: string): string {
  return loose(t)(`imdb:mode.${mode}`, { defaultValue: mode });
}

// --- <Select> option builders (translated) ----------------------------------

export function libraryKindOptions(t: SomeT): { value: MediaKind; label: string }[] {
  return LIBRARY_KIND_VALUES.map((value) => ({ value, label: kindLabel(t, value) }));
}
export function presetOptions(t: SomeT): { value: Preset; label: string }[] {
  return PRESET_VALUES.map((value) => ({ value, label: presetLabel(t, value) }));
}
export function modeOptions(t: SomeT): { value: RenameMode; label: string }[] {
  return MODE_VALUES.map((value) => ({ value, label: modeLabel(t, value) }));
}
export function mediaTypeOptions(t: SomeT): { value: MediaItemType; label: string }[] {
  return MEDIA_TYPE_VALUES.map((value) => ({ value, label: mediaTypeLabel(t, value) }));
}
export function matchStatusOptions(t: SomeT): { value: MediaMatchStatus; label: string }[] {
  return MATCH_STATUS_VALUES.map((value) => ({ value, label: matchStatusLabel(t, value) }));
}
export function mediaServerKindOptions(t: SomeT): { value: string; label: string }[] {
  return MEDIA_SERVER_KIND_VALUES.map((value) => ({ value, label: mediaServerKindLabel(t, value) }));
}
export function imdbModeOptions(t: SomeT): { value: string; label: string }[] {
  return IMDB_MODE_VALUES.map((value) => ({ value, label: imdbModeLabel(t, value) }));
}
export function imdbTitleKindOptions(t: SomeT): { value: string; label: string }[] {
  return IMDB_TITLE_KIND_VALUES.map((value) => ({
    value,
    label: loose(t)(`imdb:titleKind.${value}`, { defaultValue: value }),
  }));
}

// --- Badge variants (no user-facing text) -----------------------------------

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

/** Colored badge variant for an IMDb dataset-import status. */
export function imdbImportStatusVariant(
  status: string,
): 'success' | 'info' | 'warning' | 'destructive' | 'secondary' {
  switch (status) {
    case 'completed':
      return 'success';
    case 'running':
    case 'validating':
      return 'info';
    case 'pending':
      return 'warning';
    case 'failed':
      return 'destructive';
    case 'stopping':
      return 'warning';
    case 'cancelled':
      return 'secondary';
    default:
      return 'secondary';
  }
}

// ---------------------------------------------------------------------------
// IMDb helpers
// ---------------------------------------------------------------------------

/** Human label for an IMDb dataset TSV file key (dots swapped for `_` in i18n keys). */
export function imdbDatasetFileLabel(t: SomeT, key: string): string {
  return loose(t)(`imdb:datasetFile.${key.replace(/\./g, '_')}`, { defaultValue: key });
}

/** Build a public "open on IMDb" link (a string only — never fetched). */
export function imdbTitleUrl(imdbId: string): string {
  return `https://www.imdb.com/title/${imdbId}/`;
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
