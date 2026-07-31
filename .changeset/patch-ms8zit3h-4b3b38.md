---
"ultratorrent": patch
---

A missing-episode grab whose torrent the engine refused is now recorded as failed instead of grabbed. The engine returns no hash when the add itself fails, and the sweep selects only idle, no_results and failed — so claiming success excluded the episode from ever being searched again. Found on a live install: 32 episodes stamped grabbed against a download action whose status was failed and whose result was null, meaning no torrent was ever added.
