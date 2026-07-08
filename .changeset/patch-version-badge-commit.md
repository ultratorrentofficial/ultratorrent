---
"ultratorrent": patch
---

Show the short git commit next to the version in the sidebar version badge and the About menu entry (e.g. `v0.25.1 · 4045eef`), so two deploys reporting the same version number but running different commits are distinguishable at a glance. The commit/tag/build-time are stamped into the backend image at build via the `GIT_SHA`/`GIT_TAG`/`BUILD_TIME` build args (new `BUILD_TIME` arg added); when unstamped, only the version shows (unchanged behavior).
