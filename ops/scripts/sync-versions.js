#!/usr/bin/env node
/*
 * sync-versions.js — propagate the canonical app version to its satellites.
 *
 * The root package.json `version` (managed by Changesets) is the single source
 * of truth. UltraTorrent has ONE canonical version across all editions; the
 * number is mirrored into every place it is read at runtime/build so they never
 * drift:
 *   - apps/backend/package.json     workspace metadata
 *   - apps/frontend/package.json    workspace metadata
 *   - packages/shared/package.json  workspace metadata
 *   - version.json                  `version` + editions.{community,sdk}
 *                                   (editions are kept in LOCKSTEP with the root)
 *   - VERSION                       -> GET /api/system/version, backend runtime read
 *   - packages/shared/VERSION       sdk edition track
 *
 * One-way (root -> satellites). Run it after `changeset version` and in the
 * deploy step. `node scripts/version.mjs check` validates there is no drift.
 *
 * Usage: node ops/scripts/sync-versions.js [--dry-run]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const dryRun = process.argv.includes('--dry-run');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const rootPkgPath = path.join(ROOT, 'package.json');
const version = readJson(rootPkgPath).version;
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`Refusing to sync: root package.json version "${version}" is not semver.`);
  process.exit(1);
}

// Bump only the FIRST "version" field (the package's own), preserving formatting.
const pkgApply = (txt) => {
  const cur = (txt.match(/"version"\s*:\s*"([^"]*)"/) || [])[1];
  return [cur, txt.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`)];
};
const plainApply = (txt) => [txt.trim(), `${version}\n`];

// version.json: set `version` and force every edition track to the canonical
// version (single canonical version across all editions).
const versionJsonApply = (txt) => {
  const vj = JSON.parse(txt);
  const before = `${vj.version} [${Object.entries(vj.editions || {})
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')}]`;
  vj.version = version;
  vj.editions = vj.editions || {};
  for (const e of Object.keys(vj.editions)) vj.editions[e] = version;
  // Ensure the canonical editions exist even on a fresh file.
  for (const e of ['community', 'sdk']) vj.editions[e] = version;
  return [before, JSON.stringify(vj, null, 2) + '\n'];
};

const targets = [
  { label: 'apps/backend/package.json', file: path.join(ROOT, 'apps', 'backend', 'package.json'), apply: pkgApply },
  { label: 'apps/frontend/package.json', file: path.join(ROOT, 'apps', 'frontend', 'package.json'), apply: pkgApply },
  { label: 'packages/shared/package.json', file: path.join(ROOT, 'packages', 'shared', 'package.json'), apply: pkgApply },
  { label: 'version.json', file: path.join(ROOT, 'version.json'), apply: versionJsonApply },
  { label: 'VERSION', file: path.join(ROOT, 'VERSION'), apply: plainApply },
  { label: 'packages/shared/VERSION', file: path.join(ROOT, 'packages', 'shared', 'VERSION'), apply: plainApply },
];

let changed = 0;
for (const t of targets) {
  let txt;
  try { txt = fs.readFileSync(t.file, 'utf8'); }
  catch { console.warn(`  ! ${t.label} not found — skipped`); continue; }
  const [cur, next] = t.apply(txt);
  if (txt === next) {
    console.log(`  = ${t.label} already ${version}`);
    continue;
  }
  changed++;
  console.log(`  ${dryRun ? '~' : '✓'} ${t.label}: ${cur} -> ${version}`);
  if (!dryRun) fs.writeFileSync(t.file, next);
}

console.log(
  `\nCanonical version ${version} — ${changed} satellite(s) ${dryRun ? 'would be' : ''} updated${dryRun ? ' (dry run)' : ''}.`
);
