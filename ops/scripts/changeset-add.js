#!/usr/bin/env node
/*
 * changeset-add.js — author a changeset non-interactively.
 *
 * Writes a `.changeset/<level>-<id>.md` declaring a SemVer bump for the single
 * canonical package (ultratorrent). Commit it together with the work it
 * describes; it stays pending until a release is cut (ops/scripts/release.js).
 *
 * Usage:
 *   node ops/scripts/changeset-add.js --level <patch|minor|major> --summary "<text>"
 *
 * Rubric: fixed it -> patch. added to it -> minor. broke/wiped it -> major.
 * See docs/VERSIONING.md.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const level = (arg('--level') || '').toLowerCase();
const summary = (arg('--summary') || '').trim();

if (!['patch', 'minor', 'major'].includes(level)) {
  console.error('Error: --level must be one of patch | minor | major');
  process.exit(1);
}
if (!summary) {
  console.error('Error: --summary "<concise change description>" is required');
  process.exit(1);
}

const pkgName = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name;
const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const file = path.join(ROOT, '.changeset', `${level}-${id}.md`);

const body = `---\n"${pkgName}": ${level}\n---\n\n${summary}\n`;
fs.writeFileSync(file, body);

console.log(`Wrote ${path.relative(ROOT, file)} (${level}): ${summary}`);
console.log('Commit this file together with the change it describes.');
