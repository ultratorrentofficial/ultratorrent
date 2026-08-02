---
"ultratorrent": patch
---

A bare "Web" in a film's title is no longer read as its source. `WEB-DL` and `WEBRip` are unambiguous, but a lone `web` matched anywhere in a name — and since the title is cut at the earliest marker, every film ending in that word silently lost it. Live: "The Girl in the Spider's Web" was stored as "The Girl in the Spider's" and "Unfriended - Dark Web" as "Unfriended Dark". It only fires when nothing else in the string is a release marker, which is exactly a bare `Title (YYYY)` folder, so it corrupted the identity path specifically. `web` is now a source only when a release token follows it (`WEB.x264-GRP`, `WEB 1080p`), never as a trailing word before a year.
