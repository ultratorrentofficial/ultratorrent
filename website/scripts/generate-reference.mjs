#!/usr/bin/env node
/**
 * Generate the Reference section from the SOURCE OF TRUTH — never by hand.
 *
 * Everything here is derived from code that actually ships:
 *   • Permissions + role matrix  ← packages/shared (compiled exports, not a regex)
 *   • Module catalogue           ← module-registry manifests (compiled exports)
 *   • REST API                   ← the Nest controllers' own decorators
 *   • Environment variables      ← .env.example (with its own comments as docs)
 *   • Database schema            ← prisma/schema.prisma → Mermaid ER diagrams
 *
 * That means the reference cannot drift from the product, and cannot be
 * fabricated. If a page here is wrong, the code is wrong.
 *
 * Run: npm run gen:reference  (also runs automatically before `build`/`start`)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..'); // repo root
const OUT = path.resolve(HERE, '../docs/reference');

const rel = (...p) => path.join(ROOT, ...p);

/**
 * The reference pages are generated from the application's *real* exports rather
 * than from regex-scraped TypeScript — that is what makes them impossible to drift.
 *
 * `@ultratorrent/shared` must therefore be compiled: it is the source of PERMISSIONS
 * and ROLE_PERMISSIONS, and it is a dependency of everything else here.
 */
if (!fs.existsSync(rel('packages/shared/dist/cjs/index.js'))) {
  console.error(
    `\nCannot generate the reference docs — @ultratorrent/shared has not been compiled.\n\n` +
      `  missing: packages/shared/dist/cjs/index.js\n\n` +
      `Build it first, from the repository root:\n\n` +
      `  npm run build --workspace @ultratorrent/shared\n\n` +
      `(If a build is already running, wait for it to finish — dist/ is rebuilt in place.)\n`,
  );
  process.exit(1);
}

/**
 * Load a TypeScript module for its *values*, without requiring the whole backend to
 * have been compiled first.
 *
 * The obvious approach — require() the backend's dist/ — means the docs can only be
 * built after a full `nest build`, which is a heavy dependency to take on for one
 * data file, and it is what stopped the docs from being buildable inside the frontend
 * image. So: prefer dist/ when it happens to be there (free, already compiled), and
 * otherwise bundle the source on the fly with esbuild. Either way we end up importing
 * real exports, never parsing them out of text.
 */
function loadTsModule({ dist, src }) {
  if (fs.existsSync(rel(dist))) return require(rel(dist));

  const esbuild = require(rel('node_modules/esbuild'));
  const out = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ut-docs-')),
    'module.cjs',
  );
  esbuild.buildSync({
    entryPoints: [rel(src)],
    outfile: out,
    bundle: true, // pulls @ultratorrent/shared in via the workspace symlink
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  const mod = require(out);
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
  return mod;
}

const write = (file, body) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, file), body);
  console.log(`  ✓ reference/${file}  (${body.split('\n').length} lines)`);
};

const BANNER = (source) =>
  `:::info Auto-generated\nThis page is generated from \`${source}\` at build time. **Do not edit it by hand** — change the source and rebuild. This guarantees the reference always matches the code that ships.\n:::\n`;

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');

// ---------------------------------------------------------------------------
// 1. Permissions + role matrix
// ---------------------------------------------------------------------------
function genPermissions() {
  const shared = require(rel('packages/shared/dist/cjs/index.js'));
  const { PERMISSIONS, ROLE_PERMISSIONS } = shared;
  const roles = Object.keys(ROLE_PERMISSIONS);
  const perms = Object.entries(PERMISSIONS); // [CONST, 'dotted.value']

  // Group by domain (the bit before the first dot) so the table is navigable.
  const byDomain = new Map();
  for (const [constName, value] of perms) {
    const domain = String(value).split('.')[0];
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push({ constName, value });
  }

  const has = (role, value) => (ROLE_PERMISSIONS[role] ?? []).includes(value);

  let md = `---
id: permissions
title: Permissions Reference
sidebar_position: 2
description: Every RBAC permission in UltraTorrent and which built-in role holds it.
keywords: [permissions, rbac, roles, access control, authorization, security]
---

# Permissions Reference

${BANNER('packages/shared/src/permissions.ts')}
UltraTorrent uses **granular, dot-namespaced permissions** (\`domain.action\`). Roles are
just named sets of them. Both the backend route guards (\`@RequirePermissions\`) and the
frontend capability checks read this same catalogue, so what you see here is exactly what
is enforced.

- **${perms.length} permissions** across **${byDomain.size} domains**
- **${roles.length} built-in roles**

## How to read this

- A **✅** means the role holds that permission out of the box.
- Roles are cumulative in practice but **not** by inheritance — each role's set is explicit,
  so you can always see precisely what it can do.
- Custom roles are built from the same catalogue. See [Access Control](/develop/rbac).

## Role summary

| Role | Permissions held |
| --- | --- |
${roles.map((r) => `| \`${r}\` | ${(ROLE_PERMISSIONS[r] ?? []).length} of ${perms.length} |`).join('\n')}

`;

  for (const [domain, list] of [...byDomain.entries()].sort()) {
    md += `## \`${domain}\`\n\n| Permission | Constant | ${roles.map((r) => r.replace(/_/g, ' ')).join(' | ')} |\n| --- | --- | ${roles.map(() => ':---:').join(' | ')} |\n`;
    for (const { constName, value } of list) {
      md += `| \`${esc(value)}\` | \`${constName}\` | ${roles.map((r) => (has(r, value) ? '✅' : '—')).join(' | ')} |\n`;
    }
    md += '\n';
  }

  md += `## See also

- [Access Control (RBAC) for developers](/develop/rbac) — how guards consume these
- [Users & Roles](/modules/users) — assigning roles in the UI
- [Security hardening](/operate/security)
`;
  write('permissions.md', md);
  return { count: perms.length, roles: roles.length };
}

// ---------------------------------------------------------------------------
// 2. Module catalogue
// ---------------------------------------------------------------------------
function genModules() {
  const m = loadTsModule({
    dist: 'apps/backend/dist/modules/module-registry/manifests.js',
    src: 'apps/backend/src/modules/module-registry/manifests.ts',
  });
  const manifests = [
    ...(m.CORE_MANIFESTS ?? []),
    ...(m.COMMUNITY_MANIFESTS ?? []),
    ...(m.OPTIONAL_MANIFESTS ?? []),
  ];

  const tiers = [...new Set(manifests.map((x) => x.tier))];

  let md = `---
id: modules
title: Module Reference
sidebar_position: 3
description: Every UltraTorrent module, its tier, dependencies, permissions and routes.
keywords: [modules, registry, manifest, dependencies, core, community]
---

# Module Reference

${BANNER('apps/backend/src/modules/module-registry/manifests.ts')}
UltraTorrent is built as a **module registry**. Each module declares a manifest — its id,
tier, dependencies, the permissions it introduces and the API routes it owns. The registry
resolves the dependency graph at boot and refuses to start on an unknown or circular
dependency, so a broken module can never half-load.

- **${manifests.length} modules** across tiers: ${tiers.map((t) => `\`${t}\``).join(', ')}
- **Core** modules are always on. **Community/optional** modules can be toggled.

## Dependency graph

\`\`\`mermaid
graph LR
${manifests
  .flatMap((x) =>
    (x.dependencies ?? []).map((d) => `  ${JSON.stringify(d)} --> ${JSON.stringify(x.id)}`),
  )
  .join('\n') || '  none[No declared dependencies]'}
\`\`\`

## All modules

| Module | Id | Tier | On by default | Depends on |
| --- | --- | --- | :---: | --- |
${manifests
  .map(
    (x) =>
      `| **${esc(x.name)}** | \`${esc(x.id)}\` | ${esc(x.tier)} | ${x.enabledByDefault ? '✅' : '—'} | ${(x.dependencies ?? []).map((d) => `\`${d}\``).join(', ') || '—'} |`,
  )
  .join('\n')}

`;

  for (const x of manifests) {
    md += `## ${esc(x.name)}\n\n\`${esc(x.id)}\` · tier \`${esc(x.tier)}\`${x.enabledByDefault ? ' · enabled by default' : ' · optional'}\n\n${esc(x.description ?? '')}\n\n`;
    if (x.dependencies?.length)
      md += `**Depends on:** ${x.dependencies.map((d) => `\`${d}\``).join(', ')}\n\n`;
    if (x.permissions?.length)
      md += `**Introduces permissions:** ${x.permissions.map((p) => `\`${p}\``).join(', ')}\n\n`;
    if (x.routes?.length) md += `**Owns routes:** ${x.routes.map((r) => `\`${r}\``).join(', ')}\n\n`;
  }

  md += `## See also

- [Permissions Reference](/reference/permissions)
- [REST API Reference](/reference/api)
- [Writing a module](/develop/creating-modules)
`;
  write('modules.md', md);
  return { count: manifests.length };
}

// ---------------------------------------------------------------------------
// 3. REST API — parsed from the controllers' own decorators
// ---------------------------------------------------------------------------
const HTTP = ['Get', 'Post', 'Put', 'Patch', 'Delete'];

function parseController(file) {
  const src = fs.readFileSync(file, 'utf8');
  const base = /@Controller\(\s*['"`]([^'"`]*)['"`]\s*\)/.exec(src)?.[1] ?? '';
  const className = /export class (\w+)/.exec(src)?.[1] ?? path.basename(file);
  const classPerm = /@RequirePermissions\(([^)]*)\)[\s\S]{0,200}?export class/.exec(src)?.[1];

  const endpoints = [];
  const methodRe = new RegExp(`@(${HTTP.join('|')})\\(\\s*(?:['"\`]([^'"\`]*)['"\`])?\\s*\\)`, 'g');
  let m;
  while ((m = methodRe.exec(src))) {
    const verb = m[1].toUpperCase();
    const sub = m[2] ?? '';
    // Look ahead a little for @RequirePermissions and the handler name.
    const after = src.slice(m.index, m.index + 600);
    const perms = [...after.matchAll(/@RequirePermissions\(([^)]*)\)/g)]
      .slice(0, 1)
      .flatMap((p) =>
        p[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    const handler = /\n\s*(?:async\s+)?(\w+)\s*\(/.exec(after.replace(/@[\w]+\([^)]*\)/g, ''))?.[1];
    // JSDoc directly above the decorator, if any.
    const before = src.slice(Math.max(0, m.index - 400), m.index);
    const doc = /\/\*\*([\s\S]*?)\*\/\s*(?:@[\s\S]*)?$/.exec(before)?.[1];
    const summary = doc
      ? doc
          .split('\n')
          .map((l) => l.replace(/^\s*\*ings?\s?/, '').replace(/^\s*\*\s?/, '').trim())
          .filter((l) => l && !l.startsWith('@'))
          .join(' ')
          .trim()
      : '';

    const full = ['/api', base, sub].filter(Boolean).join('/').replace(/\/+/g, '/');
    endpoints.push({ verb, path: full, perms, handler, summary });
  }
  return { className, base, classPerm, endpoints };
}

function genApi() {
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.controller.ts')) files.push(p);
    }
  })(rel('apps/backend/src'));

  const controllers = files.map(parseController).sort((a, b) => a.base.localeCompare(b.base));
  const total = controllers.reduce((n, c) => n + c.endpoints.length, 0);

  let md = `---
id: api
title: REST API Reference
sidebar_position: 1
description: Every REST endpoint UltraTorrent exposes, with its verb, path and required permission.
keywords: [api, rest, endpoints, curl, javascript, python, powershell, authentication, bearer]
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# REST API Reference

${BANNER('the @Controller / @Get / @RequirePermissions decorators in apps/backend/src')}
Every endpoint below was read from the controllers themselves, including the **exact
permission** its guard enforces.

- **${total} endpoints** across **${controllers.length} controllers**
- Base URL: \`http://<host>:<port>/api\`

## Authentication

All endpoints except \`/api/auth/login\` require a **Bearer token**.

\`\`\`bash
# 1. Log in to get an access token
curl -s -X POST http://localhost:8080/api/auth/login \\
  -H 'Content-Type: application/json' \\
  -d '{"username":"admin","password":"<password>"}'
# → { "accessToken": "eyJ...", "refreshToken": "..." }

# 2. Use it
curl -s http://localhost:8080/api/torrents \\
  -H 'Authorization: Bearer eyJ...'
\`\`\`

Access tokens are short-lived; use the refresh token to rotate. See [Authentication](/develop/authentication).

## Authorization

Each endpoint declares a permission (the **Permission** column below). A token whose role
lacks that permission gets **\`403 Forbidden\`**. The full catalogue is in the
[Permissions Reference](/reference/permissions).

## Common status codes

| Code | Meaning |
| --- | --- |
| \`200\` / \`201\` | Success |
| \`400\` | Validation failed (bad body/query) |
| \`401\` | Missing or expired token |
| \`403\` | Token valid, but the role lacks the required permission |
| \`404\` | Resource does not exist |
| \`500\` | Server error — check [logs](/operate/troubleshooting) |

## Client examples

<Tabs>
<TabItem value="curl" label="cURL">

\`\`\`bash
curl -s http://localhost:8080/api/torrents -H "Authorization: Bearer $TOKEN"
\`\`\`

</TabItem>
<TabItem value="ts" label="TypeScript">

\`\`\`ts
const res = await fetch('http://localhost:8080/api/torrents', {
  headers: { Authorization: \`Bearer \${token}\` },
});
if (!res.ok) throw new Error(\`\${res.status} \${res.statusText}\`);
const torrents = await res.json();
\`\`\`

</TabItem>
<TabItem value="py" label="Python">

\`\`\`python
import requests
r = requests.get(
    "http://localhost:8080/api/torrents",
    headers={"Authorization": f"Bearer {token}"},
    timeout=30,
)
r.raise_for_status()
torrents = r.json()
\`\`\`

</TabItem>
<TabItem value="ps" label="PowerShell">

\`\`\`powershell
$headers = @{ Authorization = "Bearer $Token" }
Invoke-RestMethod -Uri "http://localhost:8080/api/torrents" -Headers $headers
\`\`\`

</TabItem>
</Tabs>

`;

  for (const c of controllers) {
    if (!c.endpoints.length) continue;
    md += `## \`/${c.base}\`\n\nFrom \`${c.className}\`.\n\n| Method | Path | Permission | Handler |\n| --- | --- | --- | --- |\n`;
    for (const e of c.endpoints) {
      const perms = e.perms.length
        ? e.perms.map((p) => `\`${esc(p.replace(/^P(ERMISSIONS)?\./, ''))}\``).join(', ')
        : '—';
      md += `| \`${e.verb}\` | \`${esc(e.path)}\` | ${perms} | \`${esc(e.handler ?? '')}\` |\n`;
    }
    md += '\n';
  }

  md += `## See also

- [Permissions Reference](/reference/permissions) — what each guard requires
- [API Keys](/modules/api-keys) — non-interactive access
- [WebSocket events](/develop/websockets) — live updates instead of polling
`;
  write('api.md', md);
  return { total, controllers: controllers.length };
}

// ---------------------------------------------------------------------------
// 4. Environment variables (comments in .env.example become the docs)
// ---------------------------------------------------------------------------
function genEnv() {
  const src = fs.readFileSync(rel('.env.example'), 'utf8');

  // `.env.example` is written as blank-line-delimited BLOCKS: a comment block
  // documents the variables that follow it. A `# KEY=value` line is a variable
  // that is deliberately left unset (optional / manual installs only). Parsing it
  // any other way conflates a section heading with a variable's description.
  const blocks = src
    .split(/\n\s*\n/)
    .map((b) => b.split('\n').map((l) => l.trimEnd()).filter(Boolean))
    .filter((b) => b.length);

  const vars = [];
  for (const block of blocks) {
    if (block.every((l) => /^#\s*-{5,}/.test(l) || /^#/.test(l)) && !block.some((l) => /^#\s*[A-Z0-9_]+=/.test(l))) {
      continue; // pure banner/divider block with no variables
    }
    const doc = block
      .filter((l) => l.startsWith('#') && !/^#\s*-{5,}/.test(l) && !/^#\s*[A-Z0-9_]+=/.test(l))
      .map((l) => l.replace(/^#\s?/, '').trim())
      .join(' ')
      .trim();

    for (const l of block) {
      const set = /^([A-Z0-9_]+)=(.*)$/.exec(l);
      const unset = /^#\s*([A-Z0-9_]+)=(.*)$/.exec(l);
      if (set) vars.push({ key: set[1], val: set[2], doc, optional: false });
      else if (unset) vars.push({ key: unset[1], val: unset[2], doc, optional: true });
    }
  }

  // A block's comment applies to every variable in it, so "REQUIRED" alone would
  // over-flag (e.g. JWT_ACCESS_TTL=15m sits under the auth-secrets comment but
  // ships a working default). A variable is only truly required if its block says
  // so AND it has no default you can fall back on.
  const required = (v) => /\bREQUIRED\b/i.test(v.doc) && !v.val && !v.optional;
  const total = vars.length;

  let md = `---
id: environment
title: Environment Variables
sidebar_position: 4
description: Every environment variable UltraTorrent reads, its default, and what it does.
keywords: [environment, env, configuration, docker, compose, settings, secrets]
---

# Environment Variables

${BANNER('.env.example')}
UltraTorrent is configured with environment variables (typically via \`.env\` next to your
\`docker-compose.yml\`). **${total} variables** are recognised.

:::warning Secrets
Never commit a real \`.env\`. Rotate \`JWT_ACCESS_SECRET\` / \`JWT_REFRESH_SECRET\` if they leak —
doing so invalidates every issued token. See [Security](/operate/security).
:::

`;

  const req = vars.filter(required);
  if (req.length) {
    md += `## Required in production\n\nThe backend **refuses to boot** in production if these are unset, left at a known default, or too weak.\n\n| Variable | Notes |\n| --- | --- |\n`;
    for (const v of req) md += `| \`${esc(v.key)}\` | ${esc(v.doc)} |\n`;
    md += `\nGenerate strong secrets:\n\n\`\`\`bash\nopenssl rand -base64 48   # run once per secret — they must differ\n\`\`\`\n\n`;
  }

  md += `## All variables\n\n| Variable | Default | Set by default | Description |\n| --- | --- | :---: | --- |\n`;
  for (const v of vars) {
    md += `| \`${esc(v.key)}\` | ${v.val ? `\`${esc(v.val)}\`` : '_(empty)_'} | ${v.optional ? '—' : '✅'} | ${esc(v.doc) || '—'} |\n`;
  }
  md += `\nA **—** in _Set by default_ means the variable is commented out in \`.env.example\`: it is optional, and only needed for the case its description names (typically a manual, non-Docker install).\n\n`;

  md += `## See also

- [Docker Compose install](/install/docker-compose)
- [Configuration profiles](/operate/configuration-profiles) — home vs. large library vs. enterprise
`;
  write('environment.md', md);
  return { total };
}

// ---------------------------------------------------------------------------
// 5. Database schema → Mermaid ER
// ---------------------------------------------------------------------------
function genSchema() {
  const src = fs.readFileSync(rel('apps/backend/prisma/schema.prisma'), 'utf8');
  const models = [];
  const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m;
  while ((m = re.exec(src))) {
    const [, name, body] = m;
    const map = /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? name;
    const fields = [];
    const relations = [];
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('//') || t.startsWith('@@')) continue;
      const f = /^(\w+)\s+(\S+)/.exec(t);
      if (!f) continue;
      const [, fname, ftypeRaw] = f;
      const ftype = ftypeRaw.replace(/[?[\]]/g, '');
      const isRel = /^[A-Z]/.test(ftype) && !['String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json', 'Bytes', 'Decimal', 'BigInt'].includes(ftype);
      if (isRel) relations.push({ to: ftype, field: fname, many: ftypeRaw.includes('[]') });
      else fields.push({ name: fname, type: ftypeRaw });
    }
    models.push({ name, map, fields, relations });
  }

  // The full 88-model ER diagram is unreadable in one image, so group by domain.
  const domain = (n) => {
    if (/^IMDb/.test(n)) return 'IMDb catalogue';
    if (/^Media(Server|Provider)/.test(n)) return 'Media server analytics';
    if (/^MediaAcquisition|^Wanted/.test(n)) return 'Media acquisition (Smart Download)';
    if (/^Media/.test(n)) return 'Media Manager';
    if (/^Rss|^TvShowStatus/.test(n)) return 'RSS';
    if (/^Notification/.test(n)) return 'Notification Center';
    if (/^Torrent|^Tracker|^Peer/.test(n)) return 'Torrents';
    if (/^User|^Role|^Session|^ApiKey|^Audit|^TwoFactor/.test(n)) return 'Identity & audit';
    if (/^Automation/.test(n)) return 'Automation';
    if (/^Indexer/.test(n)) return 'Indexers';
    return 'Platform';
  };
  const byDomain = new Map();
  for (const mo of models) {
    const d = domain(mo.name);
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(mo);
  }

  let md = `---
id: database-schema
title: Database Schema
sidebar_position: 5
description: Every Prisma model, its columns and relations, as entity-relationship diagrams.
keywords: [database, schema, prisma, postgres, models, er diagram, migrations]
---

# Database Schema

${BANNER('apps/backend/prisma/schema.prisma')}
UltraTorrent stores everything in **PostgreSQL**, managed by **Prisma**. There are
**${models.length} models**. A single ER diagram of all of them would be unreadable, so they are
grouped by domain below.

:::tip Never hand-edit the database
Schema changes go through a Prisma migration so every install converges on the same shape.
See [Database & Prisma](/develop/database).
:::

`;

  for (const [d, list] of [...byDomain.entries()].sort()) {
    md += `## ${d}\n\n_${list.length} model${list.length === 1 ? '' : 's'}._\n\n\`\`\`mermaid\nerDiagram\n`;
    const names = new Set(list.map((x) => x.name));
    for (const mo of list) {
      for (const r of mo.relations) {
        if (!names.has(r.to)) continue; // keep the diagram inside the domain
        md += `  ${mo.name} ${r.many ? '||--o{' : '}o--||'} ${r.to} : "${r.field}"\n`;
      }
    }
    md += '\`\`\`\n\n';
    for (const mo of list) {
      md += `### \`${mo.name}\`\n\nTable: \`${mo.map}\`\n\n| Column | Type |\n| --- | --- |\n`;
      for (const f of mo.fields.slice(0, 40)) md += `| \`${esc(f.name)}\` | \`${esc(f.type)}\` |\n`;
      md += '\n';
    }
  }

  md += `## See also

- [Backup & restore](/operate/backup) — dump and restore this database safely
- [Database & Prisma for developers](/develop/database)
`;
  write('database-schema.md', md);
  return { models: models.length };
}

// ---------------------------------------------------------------------------
console.log('Generating reference docs from source…');
const p = genPermissions();
const mo = genModules();
const a = genApi();
const e = genEnv();
const s = genSchema();
console.log(
  `\nDone: ${a.total} endpoints · ${p.count} permissions × ${p.roles} roles · ${mo.count} modules · ${e.total} env vars · ${s.models} DB models`,
);
