# Changesets

This folder holds **changesets** — one Markdown file per shipped change, each
declaring a SemVer bump level (`patch` / `minor` / `major`) and a summary.
They accumulate here until a release is cut, at which point they are consumed
into a version bump + `CHANGELOG.md` entry and deleted.

- **Author one** (preferred): `node ops/scripts/changeset-add.js --level <patch|minor|major> --summary "…"`
- **Plan a release:** `node ops/scripts/release.js`
- **Cut a release:** `node ops/scripts/release.js --apply --yes`

Full policy: [`docs/VERSIONING.md`](../docs/VERSIONING.md).
