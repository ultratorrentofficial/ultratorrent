---
'@ultratorrent/backend': patch
---

fix(media): NFO external ids are no longer read out of the cast list

tinyMediaManager writes a `<tvdbid>` inside **every** `<actor>` block. The NFO parser
searched the whole document for `<tvdbid>` and preferred that bare tag over the explicit
`<uniqueid type="tvdb">`, so it imported the **first cast member's** id as the episode's:

```xml
<uniqueid default="false" type="tvdb">7984092</uniqueid>   <!-- Dickinson S02E02 -->
<actor><name>Hailee Steinfeld</name><tvdbid>247867</tvdbid></actor>   <!-- an ACTOR -->
```

On a real library that put `247867` on the whole of Dickinson season 2 — and on Game of
Thrones, and on Marvel's Luke Cage, because the same actor is in all three. It is what
produced **871 tvdb ids shared across unrelated shows (3,278 items)**: shared *cast*, not
shared episodes. IMDb was untouched only because the sidecars carry no `<imdbid>` inside
an actor.

Ids are now read with the `<actor>` blocks excluded, and `<uniqueid>` — which is
explicitly typed and cannot be confused with anything else — wins over the legacy bare
tag. The cast itself is still parsed; only the id scan ignores it.
