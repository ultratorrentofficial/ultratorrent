---
"ultratorrent": minor
---

A movie's folder now follows the naming template, in every mode. rename_in_place discarded the template's leading folder segment and rejoined onto whatever folder the file already occupied, so a release folder survived forever: 'A Sense Of Dread (2026) [1080p] [WEBRip] [YTS.GG - YTS.BZ]/' kept its name while the file inside was renamed perfectly. On the live library 34 movie folders were in that state, and the rename log confirms a folder had NEVER been a rename candidate in any mode. The carve-out is correct for TELEVISION — a show folder is shared by every season, and a template whose year is missing would fork 'Show (2021)/' into a second bare 'Show/' — but nothing else lives in a movie's folder, so re-rooting it cannot split anything. Movies now take the full templated path and land in 'Title (Year)/', matching what Media Intake already produced for imports; television keeps the existing protection, pinned by a test.
