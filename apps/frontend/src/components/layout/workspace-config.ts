import type { JobSubsystem } from '@/lib/api';

/**
 * Per-workspace shell configuration: which command-palette quick actions surface on a
 * workspace's Overview, and which job subsystems its Jobs widget watches. Keyed by
 * workspace id (see `NAV_DOMAINS`). Actions are referenced by their palette action id
 * so gating (permission + module) is inherited from `usePaletteProviders` — an action
 * the user can't perform simply won't appear. Absent keys mean "no quick actions" /
 * "no jobs widget" for that workspace.
 */
export const WORKSPACE_ACTION_IDS: Record<string, string[]> = {
  downloads: ['add-torrent', 'rss-rule'],
  media: ['scan-library', 'find-duplicates'],
  automation: ['automation'],
};

/** Job subsystems a workspace's Jobs widget aggregates (`'all'` = the System view). */
export const WORKSPACE_JOB_SUBSYSTEMS: Record<string, JobSubsystem[] | 'all'> = {
  media: ['media', 'subtitle'],
  analytics: ['analytics_import'],
  automation: ['notification'],
  system: 'all',
};
