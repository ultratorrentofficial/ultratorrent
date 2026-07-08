---
"ultratorrent": patch
---

Sidebar version badge now shows the full `git describe` release tag (e.g. `v0.26.0-3-ge877a84`) next to the version instead of only the short commit, and colorizes the two: the version in light green and the release tag in white. Falls back to the short commit when the tag just repeats the version, and shows the version alone on a build with no git stamp.
