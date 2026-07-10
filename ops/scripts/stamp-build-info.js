#!/usr/bin/env node
/*
 * stamp-build-info.js — write the current git commit / describe-tag / build-time
 * to `build-info.json` at the repo root.
 *
 * This file is baked into the backend image (see apps/backend/Dockerfile) and
 * read at runtime by GET /api/system/version (config/build-info.ts). It is how
 * the UI version badge shows `v<version> - (<short-sha>)` even when the Docker
 * build args (GIT_SHA/GIT_TAG/BUILD_TIME) are NOT passed — i.e. a plain
 * `docker compose build`. The build args, when present, still take priority.
 *
 * Runs automatically from:
 *   - ops/scripts/docker-build.sh (before every image build)
 *   - the git hooks in .githooks/ (post-merge/post-checkout/post-commit), so a
 *     `git pull` on a deploy host refreshes the stamp on disk.
 *
 * Best-effort: with no git available (e.g. a tarball export) it leaves any
 * existing stamp untouched rather than blanking it, and never fails a build.
 *
 * Usage: node ops/scripts/stamp-build-info.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'build-info.json');

function git(args) {
  try {
    const out = execFileSync('git', args, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

const gitSha = git(['rev-parse', 'HEAD']);
const gitTag = git(['describe', '--tags', '--always', '--dirty']);
// new Date() is fine here: this is a host build tool, not the app runtime.
const buildTime = new Date().toISOString();

// No git (shallow/tarball export): keep a previously-good stamp rather than
// overwriting it with nulls.
if (!gitSha && fs.existsSync(OUT)) {
  process.exit(0);
}

fs.writeFileSync(OUT, JSON.stringify({ gitSha, gitTag, buildTime }, null, 2) + '\n');
console.log(
  `build-info.json: sha=${(gitSha || '<none>').slice(0, 12)}${gitSha ? '…' : ''} ` +
    `tag=${gitTag || '<none>'} time=${buildTime}`,
);
