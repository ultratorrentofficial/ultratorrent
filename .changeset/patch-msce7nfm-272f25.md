---
"ultratorrent": patch
---

The torrent delete path no longer kills the app at boot. Injecting MediaBulkService into TorrentsService the ordinary way meant importing MediaModule into TorrentsModule, and that closed a module cycle — automation → rss → media-intake → media. Nest then evaluated MediaIntakeModule while MediaModule was still initialising, so its import resolved to undefined and the app died at bootstrap with 'the module at index [3] of the MediaIntakeModule imports array is undefined'. Nothing else caught it: both type checks passed, and all 3096 unit tests passed, because a module cycle is neither a type error nor observable from a unit test that constructs the service by hand. Only a fresh build and boot fails, which is exactly the gate it is there for. The dependency is runtime-only — needed when someone deletes a torrent's data, never at wiring time — so it now resolves lazily through ModuleRef and the module edge is gone entirely. Behaviour is unchanged.
