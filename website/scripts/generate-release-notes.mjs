/**
 * Release notes, generated from the repository's CHANGELOG.md.
 *
 * The changelog is already the canonical, human-written record of what shipped
 * in each version — it is produced from changesets at release time and reviewed
 * as part of the release. Re-typing any of it into the docs site would create a
 * second record that silently disagrees with the first, which is worse than
 * having no page at all: a reader cannot tell which one is lying.
 *
 * So this reads CHANGELOG.md and renders it. The page cannot drift, because
 * there is nothing to drift from.
 *
 * Run: npm run gen:release-notes  (also runs as part of `gen`, before build/start)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHANGELOG = path.resolve(HERE, '../../CHANGELOG.md');
const OUT = path.resolve(HERE, '../docs/release-notes');
const ES_OUT = path.resolve(HERE, '../i18n/es-PR/docusaurus-plugin-content-docs/current/release-notes');

/*
 * How many releases get a rendered entry.
 *
 * The changelog is ~300 KB and reaches back to 0.1.0. Rendering all of it makes
 * a page nobody can use and a build that carries every historical entry into two
 * locales. Recent releases are what a reader is actually asking about; the rest
 * is one link away, and the page says so rather than pretending it is complete.
 */
const RECENT = 25;

if (!fs.existsSync(CHANGELOG)) {
  console.error(`generate-release-notes: CHANGELOG.md not found at ${CHANGELOG}`);
  process.exit(1);
}

const raw = fs.readFileSync(CHANGELOG, 'utf8');

/**
 * Parse `## [x.y.z] - date` sections and their `### Group` bullet lists.
 *
 * Anything that is not a released version — the `[Unreleased]` block — is
 * skipped: it describes work that is not in anyone's install, and putting it on
 * a page headed "what shipped" would be a straightforward lie.
 */
function parse(md) {
  const releases = [];
  const lines = md.split('\n');
  let cur = null;
  let group = null;

  for (const line of lines) {
    const head = line.match(/^## \[([^\]]+)\](?:\s*-\s*(\S+))?/);
    if (head) {
      const [, version, date] = head;
      if (!/^\d+\.\d+\.\d+/.test(version)) {
        cur = null;           // [Unreleased] and friends
        continue;
      }
      cur = { version, date: date ?? null, groups: [] };
      releases.push(cur);
      group = null;
      continue;
    }
    if (!cur) continue;

    const sub = line.match(/^### (.+?)\s*$/);
    if (sub) {
      group = { name: sub[1], items: [] };
      cur.groups.push(group);
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet && group) {
      group.items.push(bullet[1].trim());
      continue;
    }
    // A wrapped continuation line of the previous bullet.
    if (group?.items.length && /^\s{2,}\S/.test(line)) {
      group.items[group.items.length - 1] += ' ' + line.trim();
    }
  }
  return releases.filter((r) => r.groups.some((g) => g.items.length));
}

const releases = parse(raw);
if (!releases.length) {
  console.error(
    'generate-release-notes: parsed zero releases from CHANGELOG.md.\n' +
      'The heading format has changed — update this parser rather than shipping an empty page.',
  );
  process.exit(1);
}

const shown = releases.slice(0, RECENT);
const REPO = 'https://github.com/ultratorrentofficial/ultratorrent';

/** Group names as they appear in the changelog, and what they mean to a reader. */
const GROUPS = {
  en: { Added: 'New', Changed: 'Changed', Fixed: 'Fixed', Removed: 'Removed', Security: 'Security', Notes: 'Notes' },
  es: { Added: 'Nuevo', Changed: 'Cambios', Fixed: 'Corregido', Removed: 'Eliminado', Security: 'Seguridad', Notes: 'Notas' },
};

const T = {
  en: {
    title: 'Release Notes',
    desc: 'What shipped in each version of UltraTorrent — new features, changes, and fixes.',
    heading: 'Release Notes',
    banner:
      ':::info Auto-generated\nThis page is generated from `CHANGELOG.md` at build time. **Do not edit it by hand** — change the changelog and rebuild.\n:::\n',
    intro: (n, total) =>
      `Every released version, newest first. This page shows the **${n} most recent** of **${total}** releases; ` +
      `the complete history lives in [CHANGELOG.md](${REPO}/blob/main/CHANGELOG.md).\n\n` +
      `Versions are [semantic](https://semver.org/): a **minor** bump means new capability, a **patch** means fixes only. ` +
      `Upgrading is covered in [Upgrading](/install/upgrading).`,
    latest: 'Latest release',
    older: 'Older releases',
    olderBody: `Releases before this point are in [CHANGELOG.md](${REPO}/blob/main/CHANGELOG.md), which covers the full history back to the first tag.`,
    seeAlso: 'See also',
    tagged: (v, url) => `Tagged [\`v${v}\`](${url}).`,
  },
  es: {
    title: 'Notas de Versión',
    desc: 'Qué trajo cada versión de UltraTorrent — funcionalidades nuevas, cambios y correcciones.',
    heading: 'Notas de Versión',
    banner:
      ':::info Generado automáticamente\nEsta página se genera desde `CHANGELOG.md` al compilar. **No la edites a mano** — cambia el changelog y vuelve a compilar.\n:::\n',
    intro: (n, total) =>
      `Cada versión publicada, la más reciente primero. Esta página muestra las **${n} más recientes** de **${total}** versiones; ` +
      `el historial completo está en [CHANGELOG.md](${REPO}/blob/main/CHANGELOG.md).\n\n` +
      `Las versiones son [semánticas](https://semver.org/): un salto **minor** significa capacidad nueva, un **patch** significa solo correcciones. ` +
      `La actualización se cubre en [Actualizar](/install/upgrading).`,
    latest: 'Última versión',
    older: 'Versiones anteriores',
    olderBody: `Las versiones anteriores a este punto están en [CHANGELOG.md](${REPO}/blob/main/CHANGELOG.md), que cubre el historial completo hasta la primera etiqueta.`,
    seeAlso: 'Ver también',
    tagged: (v, url) => `Etiquetada [\`v${v}\`](${url}).`,
  },
};

const LINKS = {
  en: [
    '- [Upgrading](/install/upgrading) — how to move between versions safely.',
    '- [Modules](/modules/) — what each feature does, in depth.',
    '- [Module reference](/reference/modules) — the generated manifest table.',
    '- [REST API reference](/reference/api) — every endpoint that ships.',
  ],
  es: [
    '- [Actualizar](/install/upgrading) — cómo moverte entre versiones con seguridad.',
    '- [Módulos](/modules/) — qué hace cada funcionalidad, en profundidad.',
    '- [Referencia de módulos](/reference/modules) — la tabla de manifiestos generada.',
    '- [Referencia de la API REST](/reference/api) — cada endpoint que se publica.',
  ],
};

function render(lang) {
  const t = T[lang];
  const g = GROUPS[lang === 'en' ? 'en' : 'es'];

  let md = `---
id: index
title: ${t.title}
sidebar_position: 1
description: ${t.desc}
keywords: [release notes, changelog, versions, what's new, upgrade]
---

# ${t.heading}

${t.banner}
${t.intro(shown.length, releases.length)}

`;

  if (lang === 'es') {
    md +=
      ':::note\nLas entradas del changelog se escriben en inglés en el momento del lanzamiento y se publican tal cual. Los encabezados y la estructura de esta página están traducidos; el texto de cada entrada no lo está.\n:::\n\n';
  }

  shown.forEach((r, i) => {
    md += `## ${r.version}${r.date ? ` — ${r.date}` : ''}\n\n`;
    if (i === 0) md += `_${t.latest}._\n\n`;
    for (const grp of r.groups) {
      if (!grp.items.length) continue;
      md += `### ${g[grp.name] ?? grp.name}\n\n`;
      for (const item of grp.items) md += `- ${item}\n`;
      md += '\n';
    }
    md += `${t.tagged(r.version, `${REPO}/releases/tag/v${r.version}`)}\n\n`;
  });

  md += `## ${t.older}\n\n${t.olderBody}\n\n## ${t.seeAlso}\n\n${LINKS[lang].join('\n')}\n`;
  return md;
}

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(ES_OUT, { recursive: true });

const en = render('en');
const es = render('es');
fs.writeFileSync(path.join(OUT, 'index.md'), en);
fs.writeFileSync(path.join(ES_OUT, 'index.md'), es);
fs.writeFileSync(
  path.join(OUT, '_category_.json'),
  JSON.stringify({ label: 'Release Notes', position: 8, link: { type: 'doc', id: 'release-notes/index' } }, null, 2) + '\n',
);

console.log(`Generating release notes from CHANGELOG.md…`);
console.log(`  ✓ release-notes/index.md  (${en.split('\n').length} lines)`);
console.log(`  ✓ es-PR release-notes/index.md  (${es.split('\n').length} lines)`);
console.log(`\nDone: ${shown.length} of ${releases.length} releases rendered · latest ${shown[0].version}`);
