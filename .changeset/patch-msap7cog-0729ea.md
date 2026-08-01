---
"ultratorrent": patch
---

The post-download pipeline now honours `autoOrganize`. The flag gated the library-wide organiser but not the rename that runs after a download completes, so a library opted out of automatic organising would still have its newly downloaded files renamed. The gap was masked until now: opting out used to be spelled `mode: 'preview'`, and apply short-circuits on that mode, so the stage was already a silent no-op for exactly those libraries — giving them a real verb removed the accident that was doing the work. Manual renames stay ungated.
