---
'@ultratorrent/backend': patch
---

test: fix two suites that were asserting stale/environment-dependent behaviour

Both had been failing for some time and were unrelated to any product bug.

**`system.spec.ts`** — `resolveBuildInfo()` reads the real environment: `GIT_*` vars,
else a `build-info.json` searched *up from cwd*. A developer checkout has one (the git
hook stamps it on every pull), so the "gitTag falls back to `v<version>`" test was
asserting against a real `git describe` (`v0.28.0-20-g0fd6bba-dirty`). It passed on a
clean CI clone and failed on any working tree that had ever been stamped. The module is
now mocked, so the fallback is exercised deterministically; a second test covers the
baked-stamp path that had none.

**`media-automation.actions.spec.ts`** — `organizeLibrary` was changed to plan under the
library's **real mode** with `dryRun: true`, rather than under mode `'preview'`, because
planning as `'preview'` mis-resolves an in-place move (it re-roots the file under the
library instead of reusing the show folder it already lives in) and tripped the
show-folder guard for every show whose release name embeds a bare year
(`Hijack.2023.S02E03`). Two tests still asserted the old `mode === 'preview'` contract,
and the mock keyed "did it write?" off the mode instead of `dryRun`. They now assert what
actually matters — that nothing is written — via `dryRun`.
