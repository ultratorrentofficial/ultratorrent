/**
 * What can be done about subtitles.
 *
 * These are the first actions to use `providerCapability`, and they are the
 * reason it exists: searching or downloading a subtitle is meaningless with no
 * reachable provider, and a button that always fails is worse than an absent
 * one. When every provider is unhealthy the search and download actions leave
 * the catalogue, and they come back when one recovers — with no redeploy and no
 * UI change, because availability is a registry fact rather than a component's
 * belief.
 *
 * `subtitle.sync` deliberately carries **no** provider capability. Synchronising
 * an existing subtitle against its media runs locally through ffsubsync; it
 * needs no provider at all, and gating it on one would remove the one subtitle
 * action that still works when the network is down.
 */
import { PERMISSIONS } from '@ultratorrent/shared';
import type { ActionDescriptor, EntityType } from '@ultratorrent/shared';

const P = PERMISSIONS;

/** Set on the registry when at least one subtitle provider is healthy. */
export const SUBTITLE_PROVIDER_CAPABILITY = 'subtitle.provider';

const base = {
  entityTypes: ['media_item'] as EntityType[],
  module: 'subtitle_intelligence',
  group: 'subtitles' as const,
};

export const SUBTITLE_ACTIONS: ActionDescriptor[] = [
  {
    /*
     * `POST subtitle-intelligence/items/:id/search` — one media item, which is
     * why the arity is `single` rather than `any`.
     */
    ...base,
    id: 'subtitles.search',
    arity: 'single',
    permissions: [P.SUBTITLE_INTELLIGENCE_SEARCH],
    providerCapability: SUBTITLE_PROVIDER_CAPABILITY,
    icon: 'Search',
    order: 10,
  },
];

/*
 * Deliberately NOT declared, and worth recording so they are not re-added by
 * someone reading the permission list and assuming a gap:
 *
 * - **Download** exists as `POST candidates/:candidateId/download`. It takes a
 *   *subtitle candidate* — the specific release chosen from a search result —
 *   not a media item. There is no endpoint that takes item ids and picks for
 *   itself, and inventing one is a product decision (which release wins?), not
 *   a wiring change.
 * - **Synchronise** exists as `POST downloads/:downloadId/synchronize`, keyed
 *   to a completed download rather than to the media.
 *
 * Both were declared against `media_item` in the first draft of this file. They
 * would have rendered buttons whose endpoints do not accept what the surface
 * would have sent — the exact failure CAMA.md warns about, made easy by how
 * cheap declaring an action is. They belong here once `subtitle` and the
 * download are selectable entities with surfaces that produce them.
 */
