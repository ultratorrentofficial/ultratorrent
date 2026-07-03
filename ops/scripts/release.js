#!/usr/bin/env node
/*
 * release.js — cut a release from pending changesets.
 *
 * Plan (default, read-only): lists pending changesets, the resulting bump level,
 * and current -> next version. Writes nothing.
 *
 * Apply (--apply): consumes the pending changesets — bumps the root package.json,
 * prepends a dated section to CHANGELOG.md (summaries grouped by level), and
 * deletes the consumed .changeset/*.md — then runs sync-versions.js to propagate
 * the new version to every workspace package.json, version.json (+ editions, in
 * lockstep), VERSION, and the per-edition VERSION files. Finally commits, tags
 * `vX.Y.Z`, and pushes.
 *
 * We consume the changeset files directly rather than via `changeset version`:
 * this is an npm-workspaces monorepo, where the Changesets CLI treats the root
 * `ultratorrent` as the non-versionable workspace root and would scatter the
 * changelog across each package dir. Keeping it in-script preserves ONE canonical
 * version + ONE root CHANGELOG.md.
 *
 * Single canonical version — but a bare apply is still gated behind --yes so a
 * release can't fire by accident. Docker image packaging is a separate deploy
 * step (`npm run package`).
 *
 * Usage:
 *   node ops/scripts/release.js                 # plan
 *   node ops/scripts/release.js --apply --yes   # bump + changelog + sync + git
 *   node ops/scripts/release.js --apply --yes --no-git   # files only, git left to you
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CHANGESET_DIR = path.join(ROOT, '.changeset');

const apply = process.argv.includes('--apply');
const yes = process.argv.includes('--yes');
// By default --apply also finalizes git (commit + tag + push). Pass --no-git to
// only bump the version files and leave git to the operator.
const noGit = process.argv.includes('--no-git');

const RANK = { patch: 1, minor: 2, major: 3 };

function readPending() {
  let files;
  try { files = fs.readdirSync(CHANGESET_DIR); }
  catch { return []; }
  return files
    .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .map((f) => {
      const txt = fs.readFileSync(path.join(CHANGESET_DIR, f), 'utf8');
      // frontmatter: "<pkg>": <level>  then a blank line then the summary
      const level = (txt.match(/:\s*(patch|minor|major)\s*$/m) || [])[1];
      const summary = txt.split(/^---\s*$/m).pop().trim().split('\n')[0] || '(no summary)';
      return { file: f, level, summary };
    })
    .filter((c) => c.level);
}

function bump(version, level) {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return version;
  let [maj, min, pat] = m.slice(1).map(Number);
  if (level === 'major') { maj++; min = 0; pat = 0; }
  else if (level === 'minor') { min++; pat = 0; }
  else { pat++; }
  return `${maj}.${min}.${pat}`;
}

// Map bump level -> Keep-a-Changelog section heading.
const SECTION = { major: 'Changed', minor: 'Added', patch: 'Fixed' };

// Prepend a `## [version] - YYYY-MM-DD` block to CHANGELOG.md, inserting it just
// below the `## [Unreleased]` section (or after the header if there is none), so
// releases stay in reverse-chronological order. Summaries are grouped by level.
function prependChangelog(version, changes) {
  const changelogPath = path.join(ROOT, 'CHANGELOG.md');
  const date = new Date().toISOString().slice(0, 10);
  const order = ['major', 'minor', 'patch'];
  const lines = [`## [${version}] - ${date}`, ''];
  for (const level of order) {
    const items = changes.filter((c) => c.level === level);
    if (!items.length) continue;
    lines.push(`### ${SECTION[level]}`);
    for (const c of items) lines.push(`- ${c.summary}`);
    lines.push('');
  }
  const block = lines.join('\n');

  let txt;
  try { txt = fs.readFileSync(changelogPath, 'utf8'); }
  catch { fs.writeFileSync(changelogPath, `# Changelog\n\n${block}`); return; }

  const rawLines = txt.split('\n');
  // Find the first version heading AFTER any `## [Unreleased]`; insert before it.
  let insertAt = -1;
  let seenUnreleased = false;
  for (let i = 0; i < rawLines.length; i++) {
    const isHeading = /^##\s+/.test(rawLines[i]);
    if (!isHeading) continue;
    if (/^##\s+\[?Unreleased/i.test(rawLines[i])) { seenUnreleased = true; continue; }
    if (seenUnreleased || insertAt === -1) { insertAt = i; break; }
  }
  if (insertAt === -1) {
    // No prior version section — append after a trailing newline.
    fs.writeFileSync(changelogPath, txt.replace(/\n*$/, '\n\n') + block);
  } else {
    rawLines.splice(insertAt, 0, block);
    fs.writeFileSync(changelogPath, rawLines.join('\n'));
  }
}

const pending = readPending();
const cur = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

if (pending.length === 0) {
  console.log('No pending changesets — nothing to release.');
  console.log('Author one with: node ops/scripts/changeset-add.js --level <patch|minor|major> --summary "…"');
  process.exit(0);
}

const highest = pending.reduce((a, c) => (RANK[c.level] > RANK[a] ? c.level : a), 'patch');
const next = bump(cur, highest);

console.log(`Pending changesets (${pending.length}):`);
for (const c of pending) console.log(`  [${c.level}] ${c.summary}`);
console.log(`\nRelease bump: ${highest.toUpperCase()}  ->  ${cur} → ${next}\n`);

if (!apply) {
  console.log('This was a plan (read-only). To cut the release:');
  console.log('  node ops/scripts/release.js --apply --yes');
  process.exit(0);
}

if (!yes) {
  console.log('Refusing to apply without --yes.');
  console.log(`Would bump ${cur} → ${next} and consume ${pending.length} changeset(s). Re-run with --apply --yes to proceed.`);
  process.exit(1);
}

// --- Apply ---
// 1) Bump the canonical version on the root package.json.
const rootPkgPath = path.join(ROOT, 'package.json');
const rootPkgTxt = fs.readFileSync(rootPkgPath, 'utf8');
fs.writeFileSync(rootPkgPath, rootPkgTxt.replace(/("version"\s*:\s*")[^"]*(")/, `$1${next}$2`));

// 2) Prepend a dated section to CHANGELOG.md, summaries grouped by bump level.
console.log('Updating CHANGELOG.md…');
prependChangelog(next, pending);

// 3) Delete the consumed changesets.
for (const c of pending) fs.unlinkSync(path.join(CHANGESET_DIR, c.file));
console.log(`Consumed ${pending.length} changeset(s).`);

console.log('\nSyncing satellite versions…');
execFileSync(process.execPath, [path.join(ROOT, 'ops', 'scripts', 'sync-versions.js')], { cwd: ROOT, stdio: 'inherit' });

const bumped = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const tag = `v${bumped}`;
console.log(`\n✓ Bumped ${cur} → ${bumped}.`);

if (noGit) {
  console.log('Skipped git finalize (--no-git). To finish:');
  console.log(`  git commit -am "release: ${tag}" && git tag ${tag}`);
  console.log(`  git push origin HEAD && git push origin ${tag}`);
} else {
  const git = (args) => execFileSync('git', args, { cwd: ROOT, stdio: 'inherit' });
  const gitCap = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  const branch = gitCap(['rev-parse', '--abbrev-ref', 'HEAD']);
  console.log(`\nFinalizing release on '${branch}'…`);
  git(['tag', tag]);
  git(['push', 'origin', branch]);
  git(['push', 'origin', tag]);
  console.log(`\n✓ Released ${tag}: pushed ${branch} + tag.`);
  console.log('  Build Docker images separately: npm run package.');
}
