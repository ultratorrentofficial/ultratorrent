---
"ultratorrent": patch
---

Fix TV newsletter grouping and artwork for unidentified episodes. Episodes imported with a raw release title ("Show - S02E01 - Name") and null season/episode were grouped by exact title, so each became its own one-episode "show" (blank season/episode ranges, no poster) — the newsletter looked like a wall of broken cards with almost all artwork missing. The newsletter build now normalizes the show name + season/episode from the title (reusing the RSS release-name parser) so those episodes collapse into their real show, and resolves each show's poster from the whole library by (normalized) show title — trying poster → season_poster → thumbnail → fanart — instead of relying on the newest (often artwork-less) episode's own artwork. Verified against real data: a 9-broken-card / 1-poster TV section becomes 4 correct show cards, each with its real poster.
