---
"ultratorrent": patch
---

Media Server Analytics newsletters are now split into per-content-type sections (Tautulli-style) and can be scoped to a specific type. buildContent() replaced the fixed TV+Movies model with a generalized sections model that iterates NEWSLETTER_GROUPS and emits one section per content type present (TV Shows, Movies, Music & Concerts, Documentaries, Recently Added). Episodic groups collapse into show cards ("N Shows / M Episodes") via groupShows() instead of listing every episode; other types render as poster grids ("N Movies" / "N Items"); empty groups are omitted. A newsletter can be scoped to a subset of types via contentSections — the service filters the media query by the selected groups' mediaTypes (empty = all types), so a "TV Shows" newsletter only contains grouped shows, a "Movies" one only movies, etc. The Newsletters page gained a content-type toggle-chip selector on both the create form and each newsletter card (en-US + es-PR).
