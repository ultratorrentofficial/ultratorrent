---
'@ultratorrent/backend': patch
---

Missing-episode auto-acquisition now honours the filters it was configured with, and
never files an episode outside its library folder.

**Preference resolution.** The bridge consulted only the show's linked RSS rule
(`rssRuleId`) and otherwise fell straight through to the global
`AcquisitionMatchCandidate` defaults — the auto-download **profile** was consulted by
nothing, so a profile's `requiredTerms`/`excludedTerms` were dead config. An operator
who excluded `10bit` on the "TV 1080p (auto-grab)" profile still had a 10bit release
grabbed, because the seeded default candidate gated only on codec/resolution/size
(observed: `House of the Dragon S01E04 1080p 10bit WEBRip 6CH x265 HEVC-PSA`).
`resolveCandidates` now tries, in order: the show's **RSS rule match preferences** —
by explicit link, or by an RSS rule whose *name matches the show title*, since most
monitored shows have a rule that was never wired to the watchlist item — then the
**auto-download profiles** for the media type, each profile becoming one tier ranked
by `preferredResolution` (1080p before 720p, independent of creation order) and
carrying its required/excluded terms and preferred codec/source, and only then the
global defaults.

**Save path.** A grab whose save path could not be resolved was handed to the engine
with `savePath: undefined`, which drops the file in the engine's default root instead
of the show's folder (loose episodes at `/downloads`). The path is now mandatory: when
no Show Rule path, no existing library folder and no TV library resolve, the episode is
marked `failed` with a `media_acquisition.missing_episode.no_save_path` audit record
rather than being misfiled.
