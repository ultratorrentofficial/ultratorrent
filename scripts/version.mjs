#!/usr/bin/env node
// UltraTorrent version manager (SemVer). `version.json` is the source of truth.
//
//   node scripts/version.mjs show
//   node scripts/version.mjs check                 # exit 1 if anything is out of sync
//   node scripts/version.mjs sync                  # write VERSION files + package.json
//   node scripts/version.mjs bump <patch|minor|major> --edition <sdk>
//
// `bump` moves an EDITION track only. The product version is moved solely by
// cutting a release (`ops/scripts/release.js`), which is also what consumes the
// changesets describing the move — so the canonical number never advances
// without a record of what is in it.
//
// Mapping:
//   product version  → root VERSION + every workspace package.json (one monorepo version)
//   editions.community → tracks product (the public UltraTorrent repo)
//   editions.sdk        → packages/shared/VERSION (the UltraTorrent-SDK contracts)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VJSON = join(ROOT, 'version.json');

const PKGS = [
  'package.json',
  'packages/shared/package.json',
  'apps/backend/package.json',
  'apps/frontend/package.json',
];
// edition → the VERSION file that records its release version
const EDITION_VERSION_FILE = {
  community: 'VERSION',
  sdk: 'packages/shared/VERSION',
};

const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const readVjson = () => read('version.json');
const isSemver = (v) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v);

function bump(v, kind) {
  const [maj, min, pat] = v.replace(/-.*$/, '').split('.').map(Number);
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  if (kind === 'patch') return `${maj}.${min}.${pat + 1}`;
  throw new Error(`Unknown bump kind: ${kind}`);
}

function targets() {
  const vj = readVjson();
  if (!isSemver(vj.version)) throw new Error(`version.json version "${vj.version}" is not SemVer`);
  // editions.community always tracks the product version.
  vj.editions = vj.editions || {};
  vj.editions.community = vj.version;
  return vj;
}

function doSync() {
  const vj = targets();
  // 1) every workspace package.json → product version
  for (const p of PKGS) {
    if (!existsSync(join(ROOT, p))) continue;
    const pkg = read(p);
    pkg.version = vj.version;
    writeFileSync(join(ROOT, p), JSON.stringify(pkg, null, 2) + '\n');
  }
  // 2) per-edition VERSION files
  for (const [edition, file] of Object.entries(EDITION_VERSION_FILE)) {
    const v = vj.editions[edition] ?? vj.version;
    writeFileSync(join(ROOT, file), v + '\n');
  }
  writeFileSync(VJSON, JSON.stringify(vj, null, 2) + '\n');
  console.log(`Synced product ${vj.version} (sdk ${vj.editions.sdk}).`);
}

function doCheck() {
  const vj = targets();
  const problems = [];
  for (const p of PKGS) {
    if (!existsSync(join(ROOT, p))) continue;
    const pkg = read(p);
    if (pkg.version !== vj.version) problems.push(`${p}: ${pkg.version} ≠ product ${vj.version}`);
  }
  for (const [edition, file] of Object.entries(EDITION_VERSION_FILE)) {
    const want = vj.editions[edition] ?? vj.version;
    const got = existsSync(join(ROOT, file)) ? readFileSync(join(ROOT, file), 'utf8').trim() : '(missing)';
    if (got !== want) problems.push(`${file}: ${got} ≠ ${edition} ${want}`);
  }
  if (problems.length) {
    console.error('Version check FAILED:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  console.log(`Version check OK — product ${vj.version}, sdk ${vj.editions.sdk}.`);
}

function doShow() {
  const vj = readVjson();
  console.log(`product   ${vj.version}`);
  console.log(`community ${vj.editions?.community ?? vj.version}`);
  console.log(`sdk       ${vj.editions?.sdk ?? vj.version}`);
}

function doBump(kind, edition) {
  const vj = readVjson();
  vj.editions = vj.editions || {};
  /*
   * The PRODUCT version moves only when a release is cut.
   *
   * This path bumped `version.json`, `VERSION` and every workspace package.json
   * directly — no changeset consumed, no CHANGELOG section, no tag — so the
   * canonical number could advance without any record of what changed in it.
   * `release.js` is the one thing that may move it, because it is the one thing
   * that also consumes the changesets describing the move. Nothing called this:
   * it is in no npm script and no CI job, and the only reference is the EDITION
   * track below, which is a separate number and stays available.
   */
  if (!edition || edition === 'community') {
    console.error(
      'version: refusing to bump the product version.\n' +
      '\n' +
      'The product version moves only when a release is cut, which also consumes\n' +
      'the changesets that say what changed:\n' +
      '\n' +
      '  npm run changeset:add -- --level <patch|minor|major> --summary "…"\n' +
      '  npm run release:plan\n' +
      '  npm run release:apply -- --yes --no-git\n' +
      '\n' +
      'To move a separate edition track instead, pass --edition <sdk|enterprise>.',
    );
    process.exit(2);
  }
  // Only an edition track reaches here — the product line is refused above.
  const cur = vj.editions[edition] ?? vj.version;
  vj.editions[edition] = bump(cur, kind);
  writeFileSync(VJSON, JSON.stringify(vj, null, 2) + '\n');
  console.log(`Bumped ${edition} → ${vj.editions[edition]}`);
  doSync();
}

// --- CLI ----------------------------------------------------------------
const [cmd, arg] = process.argv.slice(2);
const editionFlag = (() => {
  const i = process.argv.indexOf('--edition');
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

try {
  switch (cmd) {
    case 'show': doShow(); break;
    case 'check': doCheck(); break;
    case 'sync': doSync(); break;
    case 'bump': doBump(arg, editionFlag); break;
    default:
      console.error('Usage: version.mjs <show|check|sync|bump <patch|minor|major> [--edition sdk]>');
      process.exit(2);
  }
} catch (err) {
  console.error(`version: ${err.message}`);
  process.exit(1);
}
