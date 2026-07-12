/**
 * Capture the documentation screenshots from a live UltraTorrent.
 *
 * Auth: the app persists its tokens in localStorage under `ultratorrent.auth`, so we
 * seed a minted admin access token and skip the login form entirely.
 *
 * Every shot is best-effort: if a recipe's interaction fails (a button that isn't
 * there because the screen has no data), we record the failure and move on rather
 * than aborting the run. Unreached shots keep their placeholder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

// Point BASE at a running UltraTorrent and give it an admin access token:
//   BASE=http://localhost:8080 UT_TOKEN=<jwt> node scripts/capture-screenshots.mjs
const BASE = process.env.BASE ?? 'http://localhost:8080';
const OUT = new URL('../static/img/screenshots/', import.meta.url).pathname;
const TOKEN = process.env.UT_TOKEN;
if (!TOKEN) {
  console.error('Set UT_TOKEN to an admin access token (the app reads it from localStorage).');
  process.exit(1);
}

// name → route, plus an optional `do` that drives the UI into the state we want.
// Several doc pages illustrate the same screen from different angles; they share a route.
const click = (name) => async (p) => {
  const btn = p.getByRole('button', { name }).first();
  await btn.waitFor({ state: 'visible', timeout: 8000 });
  await btn.click();
  await p.waitForTimeout(1200);
};

const R = [
  // --- login (must be logged OUT) ---
  ['quickstart-login', '/login', null, { anon: true }],
  ['install-login', '/login', null, { anon: true }],

  // --- dashboard ---
  ['quickstart-dashboard', '/dashboard'],
  ['library-dashboard', '/dashboard'],
  ['performance-dashboard', '/dashboard'],
  ['tutorials-mature-dashboard', '/dashboard'],
  ['workflow-media-dashboard', '/dashboard'],
  ['cloud-https-dashboard', '/dashboard'],

  // --- torrents ---
  ['torrents-overview', '/torrents'],
  ['first-download-torrents-empty', '/torrents'],
  ['first-download-downloading', '/torrents'],
  ['first-download-seeding', '/torrents'],
  ['quickstart-torrents-seeding', '/torrents'],
  ['torrents-parking', '/torrents'],
  ['torrents-add', '/torrents', click(/add torrent/i)],
  ['quickstart-add-torrent', '/torrents', click(/add torrent/i)],
  ['first-download-add-dialog', '/torrents', click(/add torrent/i)],
  // The detail is a drawer: open the first row.
  [
    'torrents-detail',
    '/torrents',
    async (p) => {
      await p.locator('table tbody tr').first().click({ timeout: 8000 });
      await p.waitForTimeout(1200);
    },
  ],
  [
    'first-download-torrent-drawer',
    '/torrents',
    async (p) => {
      await p.locator('table tbody tr').first().click({ timeout: 8000 });
      await p.waitForTimeout(1200);
    },
  ],
  [
    'first-download-torrent-detail',
    '/torrents',
    async (p) => {
      await p.locator('table tbody tr').first().click({ timeout: 8000 });
      await p.waitForTimeout(1200);
    },
  ],

  // --- engines ---
  ['engines-overview', '/engines'],
  ['quickstart-engines', '/engines'],
  ['engines-add', '/engines', click(/add engine/i)],
  ['install-add-engine', '/engines', click(/add engine/i)],

  // --- indexers / prowlarr ---
  ['indexers-overview', '/indexers'],
  ['indexers-list', '/indexers'],
  ['quickstart-indexers', '/indexers'],
  ['indexers-flaresolverr', '/indexers'],
  ['prowlarr-settings', '/indexers'],
  ['prowlarr-sidebar-link', '/indexers'],
  ['indexers-add', '/indexers', click(/add indexer/i)],
  ['indexers-add-dialog', '/indexers', click(/add indexer/i)],

  // --- rss / smart download ---
  ['rss-feeds', '/rss'],
  ['rss-feeds-overview', '/rss'],
  ['rss-show-status-panel', '/rss'],
  ['tv-show-status-panel', '/rss'],
  ['workflow-rss-show-status', '/rss'],
  ['rss-smart-match-builder', '/rss'],
  ['workflow-smart-match-builder', '/rss'],
  ['smart-download-dashboard', '/media-acquisition/dashboard'],
  ['rss-smart-download-dashboard', '/media-acquisition/dashboard'],
  ['smart-download-approval-queue', '/media-acquisition'],
  ['smart-download-profile', '/media-acquisition'],
  ['smart-download-simulator', '/media-acquisition/simulator'],
  ['rss-decision-simulator', '/media-acquisition/simulator'],
  ['workflow-decision-simulator', '/media-acquisition/simulator'],
  ['release-scoring', '/release-scoring'],

  // --- missing episodes ---
  ['missing-episodes-overview', '/media-acquisition/missing-episodes'],
  ['missing-episodes-grid', '/media-acquisition/missing-episodes'],
  ['tv-missing-grid', '/media-acquisition/missing-episodes'],
  ['workflow-missing-episodes', '/media-acquisition/missing-episodes'],
  ['indexers-missing-episode-search', '/media-acquisition/missing-episodes'],
  [
    'missing-episodes-add-from-library',
    '/media-acquisition/missing-episodes',
    click(/add from library/i),
  ],
  ['tv-add-from-library', '/media-acquisition/missing-episodes', click(/add from library/i)],
  ['workflow-movie-download', '/media-acquisition'],

  // --- media manager ---
  ['media-manager-dashboard', '/media'],
  ['library-media-items', '/media/items'],
  ['media-manager-scan-progress', '/media/libraries'],
  ['library-add-dialog', '/media/libraries', click(/add library/i)],
  ['first-download-add-library', '/media/libraries', click(/add library/i)],
  ['media-manager-unmatched', '/media/unmatched'],
  ['library-unmatched', '/media/unmatched'],
  ['library-duplicates', '/media/duplicates'],
  ['media-manager-rename-preview', '/media/rename-preview'],
  ['library-rename-preview', '/media/rename-preview'],
  ['first-download-rename-preview', '/media/rename-preview'],
  ['library-media-settings', '/media/settings'],
  ['plex-media-settings-integration', '/media/settings'],
  ['media-manager-imdb-import', '/media/settings/imdb'],

  // --- media server analytics ---
  ['msa-dashboard', '/media-server-analytics'],
  ['msa-live-activity', '/media-server-analytics/live'],
  ['plex-live-activity', '/media-server-analytics/live'],
  ['first-download-media-server', '/media-server-analytics/connections'],
  ['plex-connections', '/media-server-analytics/connections'],
  ['msa-reports', '/media-server-analytics/reports'],
  ['msa-tautulli-import', '/media-server-analytics/import'],
  ['msa-newsletter-preview', '/media-server-analytics/newsletters'],

  // --- notifications ---
  ['notification-center-dashboard', '/notifications'],
  ['notification-center-channels', '/notifications/channels'],
  ['notif-channels', '/notifications/channels'],
  ['notification-center-rules', '/notifications/rules'],
  ['notif-rule-editor', '/notifications/rules'],
  ['workflow-notification-rule', '/notifications/rules'],
  ['notification-center-history', '/notifications/history'],
  ['notif-history', '/notifications/history'],
  ['notification-center-template', '/notifications/templates'],

  // --- automation ---
  ['automation-rules', '/automation'],
  ['automation-execution-log', '/automation'],
  ['automation-rule-editor', '/automation'],
  ['automation-new-rule', '/automation', click(/new rule|add rule|create rule/i)],

  // --- files ---
  ['files-overview', '/files'],
  ['first-download-file-manager', '/files'],
  ['linux-dashboard', '/dashboard'],
  ['files-default-root-path', '/files'],
  ['files-trash', '/files'],
  ['files-cleanup-wizard', '/files', click(/cleanup/i)],

  // --- users / security ---
  ['users-overview', '/users'],
  ['users-roles', '/users'],
  ['users-create', '/users', click(/add user|new user|create user/i)],
  ['users-2fa-setup', '/account'],
  ['security-settings', '/settings'],
  ['api-keys-overview', '/settings'],

  // --- system ---
  ['system-settings', '/settings'],
  ['system-health', '/settings'],
  ['architecture-system-health', '/settings'],
  ['system-maintenance', '/settings'],
  ['modules-overview', '/modules'],
  ['architecture-modules', '/modules'],
  ['audit-overview', '/audit'],
  ['audit-detail', '/audit'],
  [
    'system-version-badge',
    '/dashboard',
    async (p) => {
      await p.getByRole('button', { name: /About UltraTorrent/i }).first().click({ timeout: 10000 });
      await p.waitForTimeout(1200);
    },
  ],
  [
    'upgrade-about-version',
    '/dashboard',
    async (p) => {
      await p.getByRole('button', { name: /About UltraTorrent/i }).first().click({ timeout: 10000 });
      await p.waitForTimeout(1200);
    },
  ],
];

/**
 * These are screenshots of a real, in-use system, and they ship to a PUBLIC repo.
 * Blur the content that is the operator's private data — media titles, release names,
 * file paths, audit targets — while leaving the interface itself perfectly sharp, so
 * the screenshot still teaches the screen. Numbers, states, progress bars, buttons,
 * headings and nav all stay legible.
 */
async function redact(page) {
  await page.evaluate(() => {
    const B = 'blur(6px)';
    const hit = new Set();
    const blur = (el) => {
      if (el && !hit.has(el)) {
        el.style.filter = B;
        hit.add(el);
      }
    };

    // 1. The name/title column of any data table (the only identifying cell — the rest
    //    are sizes, ratios, peers, ETA, all safe and worth keeping readable).
    document.querySelectorAll('td[class*="max-w-"]').forEach(blur);

    // 2. Anything that looks like a release name or a media title, wherever it appears
    //    (audit targets, activity feed, unmatched items, file rows, RSS entries).
    const LOOKS_LIKE_MEDIA =
      /(S\d{1,2}E\d{1,2}|\b(19|20)\d{2}\b|\b(1080p|720p|2160p|4k)\b|web-?dl|webrip|bluray|hdtv|x26[45]|h\.?26[45]|\.(mkv|mp4|avi|nfo|srt)\b|\bseason\s+\d)/i;

    // 2a. Walk TEXT NODES, not elements. A media title is frequently a bare text node
    //     sandwiched between sibling <span>s ("system · Loot (2022) — S03E09 · action"),
    //     so its parent has children and an element-only pass misses it entirely.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);

    const PATHS = /^\/(downloads|media|mnt|share|volume|data|tv|movies)\b/i;
    for (const node of texts) {
      const t = (node.textContent || '').trim();
      if (t.length < 3) continue;
      const parent = node.parentElement;
      if (!parent || parent.closest('nav, thead, [role="tablist"]')) continue;
      if (!LOOKS_LIKE_MEDIA.test(t) && !PATHS.test(t)) continue;
      const span = document.createElement('span');
      span.style.filter = B;
      parent.replaceChild(span, node);
      span.appendChild(node);
    }

    // 3. Audit / activity subtitles read "<actor> · <target> · <action>". The target is
    //    private even when it matches no pattern (a bare show name like "Italian UFO"),
    //    so blur the whole line — the action is already spelled out in the bold title
    //    above it, so nothing is lost. Take the DEEPEST element that matches, or we
    //    would blur the entire card.
    const ACTOR_LINE = /^\s*[\w.@-]+\s+·\s+\S/;
    const all = [...document.querySelectorAll('main *, aside *')];
    for (const el of all) {
      const t = (el.textContent || '').trim();
      if (!ACTOR_LINE.test(t)) continue;
      const deeper = [...el.querySelectorAll('*')].some((c) =>
        ACTOR_LINE.test((c.textContent || '').trim()),
      );
      if (!deeper) blur(el);
    }

    // 4. Artwork. Posters and thumbnails ARE the library — and they match no text
    //    pattern. The only <img> in the content region is item artwork (the product
    //    logo lives in the sidebar), so blur them all.
    document.querySelectorAll('img').forEach((im) => {
      if (!im.closest('nav, aside, header')) blur(im); // sidebar logo stays
    });

    // 5. DEFAULT-DENY inside data cards.
    //
    //    Chasing selectors per screen kept missing things — a title is a <button> here,
    //    an <h2> there; a Plex viewer's username is just a bare <span>. Enumerating what
    //    is private is a losing game, so invert it: inside a card or list row, blur ALL
    //    text unless it is demonstrably interface furniture — an action button, a status
    //    badge, or a number. Anything unrecognised is treated as data and blurred.
    //
    //    The page's own header and toolbar sit outside any card, so they stay sharp.
    const CARD = 'li, tr, article, div[class*="rounded"]';

    // Measurements, counts, times, codecs — never identifying.
    const CHROME =
      /^([\d.,:%\/\s]+|\d+\s*(owned|missing|unaired|items?|total|active|seeders?|leechers?)|[\d.]+\s*(b|kb|mb|gb|tb|kb\/s|mb\/s|mbps|kbps)|\d+[smhd]\s*ago|(mkv|mp4|avi|aac|ac3|dts|x26[45]|h26[45]|\d{3,4}p?)|—|·)$/i;

    const isChrome = (el, text) => {
      if (CHROME.test(text)) return true;
      // "Has an icon" is NOT a safe test for an action button: the series rows wrap the
      // expand chevron AND the show title in one <button>, so an icon check whitelisted
      // the very thing we are trying to hide. Match the action LABEL instead.
      const ACTION =
        /^(scan|scan all|search|search all|re-identify|unmatch|refresh|new folder|cleanup|select all|invert|trash|add|add torrent|add from library|edit|delete|remove|save|cancel|close|browse|test|enable|disable|retry|pause|resume|start|stop|ignore|unignore|import|export|preview|send|apply|reset|back|next|view|open|copy|download|upload|rename|move|recheck)$/i;
      if (ACTION.test(text)) return true;
      // Pills / badges / chips: Ended, On hiatus, 3 missing, Direct Play, Matched.
      if (el.closest('[class*="rounded-full"], [class*="badge"], [class*="chip"]')) return true;
      if (el.closest('label, th, [role="tab"]')) return true;
      return false;
    };

    // NOT document.querySelector('main') — several screens render their content outside
    // any <main>, and scoping the walker to it skipped them entirely (their titles shipped
    // in the clear). Walk the whole document; nav/sidebar are excluded below.
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (tw.nextNode()) nodes.push(tw.currentNode);

    for (const node of nodes) {
      const el = node.parentElement;
      const text = (node.textContent || '').trim();
      if (!el || text.length < 2) continue;
      if (el.closest('nav, aside, header, thead, [role="tablist"]')) continue;
      if (!el.closest(CARD)) continue; // page header + toolbar stay sharp
      if (isChrome(el, text)) continue;
      blur(el);
    }

    // 6. Any table cell holding a name rather than a measurement. Sizes, ratios,
    //    percentages, counts and relative times are all short and/or numeric — keep
    //    them sharp; blur the wordy cells (titles, users, paths, feed names).
    document.querySelectorAll('tbody td').forEach((td) => {
      const t = (td.textContent || '').trim();
      if (t.length > 12 && /[a-z]/i.test(t) && !/^\d/.test(t)) blur(td);
    });
  });
  await page.waitForTimeout(250);
}

const ok = [];
const failed = [];

const browser = await chromium.launch();

async function shoot([name, route, action, opts = {}]) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  });
  try {
    if (!opts.anon) {
      await ctx.addInitScript(
        ([key, token]) => {
          localStorage.setItem(
            key,
            JSON.stringify({ accessToken: token, refreshToken: 'docs-capture' }),
          );
        },
        ['ultratorrent.auth', TOKEN],
      );
    }
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 90)));

    const idle = route.startsWith('/media') ? 'domcontentloaded' : 'networkidle';
    await page.goto(`${BASE}${route}`, { waitUntil: idle, timeout: 30000 });
    await page.waitForTimeout(route.startsWith('/media') ? 5000 : 1800); // charts/data settle

    if (!opts.anon && page.url().includes('/login')) {
      throw new Error('redirected to /login — token rejected');
    }

    if (action) await action(page);

    if (!opts.anon) await redact(page);

    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
    ok.push({ name, errors });
    console.log(`  ✓ ${name}${errors.length ? `  [page errors: ${errors[0]}]` : ''}`);
  } catch (err) {
    failed.push({ name, route, why: String(err.message).split('\n')[0].slice(0, 110) });
    console.log(`  ✗ ${name}  (${route})  ${String(err.message).split('\n')[0].slice(0, 70)}`);
  } finally {
    await ctx.close();
  }
}

console.log(`Capturing ${R.length} screenshots from ${BASE}\n`);
for (const r of R) await shoot(r);
await browser.close();

console.log(`\n${ok.length} captured · ${failed.length} failed`);
if (failed.length) {
  console.log('\nCould not reach:');
  for (const f of failed) console.log(`  ${f.name}  (${f.route})\n      ${f.why}`);
}
const withErrors = ok.filter((o) => o.errors.length);
if (withErrors.length) {
  console.log('\nCaptured, but the page logged a JS error:');
  for (const o of withErrors) console.log(`  ${o.name}: ${o.errors[0]}`);
}
fs.writeFileSync('/tmp/shots-report.json', JSON.stringify({ ok, failed }, null, 2));
