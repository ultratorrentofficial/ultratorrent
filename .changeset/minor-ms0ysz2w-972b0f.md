---
"ultratorrent": minor
---

Wire real producers for all 19 catalogued notification events (Phase 7). Playback, torrents, storage, workflows, providers, security and user events now fire from live code, with edge detection shared by the three polled producers so a restart cannot announce everything that was already broken.
