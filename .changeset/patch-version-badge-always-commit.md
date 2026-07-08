---
"ultratorrent": patch
---

The sidebar version badge now always shows the abbreviated commit hash (short git SHA) in white next to the version, including on exact releases. Previously it showed the `git describe` tag and hid the suffix entirely when the build sat on an exact release tag, so a released build displayed no commit at all.
