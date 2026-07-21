---
"ultratorrent": minor
---

Navigation redesign — Phase 4: pinned, favorites and recent pages (per-user).

Personal shortcuts, persisted per user (`localStorage`, keyed by user id so a shared browser doesn't leak one account's shortcuts to another; cross-device sync is a later step). Everything stores stable nav item **ids** resolved against the live RBAC-filtered entries, so a shortcut to a page the user can no longer see simply doesn't render.

- **Pinned** pages appear in a "Pinned" section at the very top of the sidebar (with an inline unpin on hover; icons-only in the collapsed rail). Pin/unpin from the command palette.
- **Favorites** — star any page; starred pages get a **Favorites** quick-access group in the command palette.
- **Recent** — the last 8 visited pages (deduped, most-recent-first) get a **Recent** quick-access group. A detail route (e.g. `/media/items/:id`) folds into its parent nav entry.

The command palette now opens to **quick access** (Pinned / Recent / Favorites) when the query is empty and falls back to the full list until you've personalised anything; typing switches to the familiar flat filtered search. Every row gained inline **pin** and **star** toggles that never navigate.

New `useNavPersonalization` hook and an `activeEntryId` resolver (`navigation.ts`). 11 new tests (hook pin/favorite/recent/per-user/no-churn, `activeEntryId` prefix resolution, palette quick-access sections + inline pin). 133 frontend tests green; typecheck + build clean; en-US/es-PR shell strings at parity.
