---
'@ultratorrent/backend': patch
---

fix(media-acquisition): stop the missing-episode sweep inventing duplicate show folders

When the sweep grabbed an episode it resolved a save path through a chain of
lookups that all demanded **exact string equality** on the title. If none matched,
the last step constructed `<TV library>/<Title> (Year)` — literally a new directory
named after whatever the watchlist entry happened to be called.

Two duplicate watchlist entries for the same show, titled `Ghosts 2021` and
`Ghosts (US)`, therefore minted `TV Shows/Ghosts 2021 (2021)` and
`TV Shows/Ghosts (US) (2021)` alongside the real `TV Shows/Ghosts US (2021)`, and
downloaded 12 episodes into them. The RSS rule that pointed at the correct folder
was skipped because it is named plain `Ghosts`, which is not string-equal to either
entry.

The chain is now:

1. the linked Show Rule's `savePath`;
2. an RSS rule named after the show;
3. **the library folder carrying the show's IMDb id** — new, and the only step that
   does not depend on titles agreeing;
4. a library item whose title matches the show;
5. **an existing show folder already in the target library** — new;
6. only then, a constructed folder.

Steps 2/4/5 compare a canonical key (case- and punctuation-insensitive, trailing
year stripped) against the entry's title *and its aliases*, so `Ghosts 2021`,
`Ghosts (US)` and the folder `Ghosts US (2021)` all reconcile. These remain
**equality** tests on that canonical form — never substring tests — so `Ghosts US`
still never collides with `Ghosts UK`, and the `Rise` / `Rise of the Merlin` class
of bug is not reintroduced.

The IMDb id is only trusted when it points at exactly **one** show folder that still
exists on disk. Real libraries carry mis-tagged items — `Masters of the Air` was
found sharing High Desert's `tt13701758` — and a naive id lookup would file High
Desert's episodes into the Masters of the Air folder. An id that resolves to two
live folders is ambiguous: the sweep logs the inconsistency and falls back to
matching on names. Folders that a library row still references but that were since
deleted or merged away are skipped.

Where a show carries no identity at all (no rule, no IMDb id, and a folder whose
name is not canonically its title), a new folder is still created rather than
guessed at: a stray folder is recoverable, filing episodes into the wrong show is
not.
