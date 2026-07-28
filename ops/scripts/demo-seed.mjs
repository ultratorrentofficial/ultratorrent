/**
 * Seed the DEV database with fictional media for documentation screenshots.
 *
 * Everything here is invented. The public repository must never carry a picture
 * of somebody's actual library — titles, file paths, viewer names and tracker
 * URLs are all real data on a live install — so the screenshots are taken
 * against this instead.
 *
 * Posters are generated locally with `sharp` rather than downloaded: a real
 * poster is someone's copyright, and a placeholder that says "no image" makes
 * the product look broken in the one screenshot meant to sell it.
 *
 *   node ops/scripts/demo-seed.mjs            # seed
 *   node ops/scripts/demo-seed.mjs --clean    # remove everything it created
 *
 * Refuses to run against anything but a local database — see assertLocal().
 */
import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.env.DEMO_ROOT ?? '/home/dayala/.ut-rtorrent/downloads/demo';
const prisma = new PrismaClient();

/** Marks every row this script creates, so --clean removes exactly those. */
const TAG = 'demo-seed';

/**
 * A destructive seed pointed at production would be unrecoverable, and the
 * connection string is one environment variable away from being the wrong one.
 */
function assertLocal() {
  const url = process.env.DATABASE_URL ?? '';
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
    throw new Error(`Refusing to seed a non-local database: ${url.replace(/:[^:@]*@/, ':***@')}`);
  }
}

/** Fictional titles. Deliberately not real films. */
const MOVIES = [
  ['The Cartographer of Small Hours', 2021, 'drama'],
  ['Nightjar', 2019, 'thriller'],
  ['Salt and Signal', 2023, 'sci-fi'],
  ['A Quiet Inventory', 2018, 'drama'],
  ['Harbour Lights', 2022, 'romance'],
  ['The Paper Astronomer', 2020, 'family'],
  ['Ferrous', 2024, 'action'],
  ['Winter Count', 2017, 'history'],
  ['The Lantern Problem', 2023, 'mystery'],
  ['Umbra', 2021, 'horror'],
  ['Every Third Thought', 2019, 'drama'],
  ['The Long Field', 2022, 'western'],
];

const SHOWS = [
  ['Meridian Street', 2020, 3, 8],
  ['The Understudy', 2022, 2, 6],
  ['Coastal Survey', 2019, 4, 10],
  ['Blue Hour', 2023, 1, 8],
];

/** Palette for generated posters — varied but consistently dark. */
const PALETTES = [
  ['#1e1b4b', '#4c1d95'], ['#0f172a', '#155e75'], ['#1c1917', '#7c2d12'],
  ['#082f49', '#0e7490'], ['#3b0764', '#831843'], ['#052e16', '#166534'],
  ['#1e1b4b', '#be123c'], ['#0c0a09', '#334155'],
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A poster: gradient, title, year. Enough to read as artwork in a grid. */
async function poster(title, year, i, out) {
  const [a, b] = PALETTES[i % PALETTES.length];
  const words = title.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > 14) { lines.push(line.trim()); line = w; }
    else line += ' ' + w;
  }
  if (line.trim()) lines.push(line.trim());

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="0.6" y2="1">
        <stop offset="0%" stop-color="${a}"/><stop offset="100%" stop-color="${b}"/>
      </linearGradient>
    </defs>
    <rect width="400" height="600" fill="url(#g)"/>
    <circle cx="330" cy="90" r="120" fill="#ffffff" opacity="0.05"/>
    <circle cx="60" cy="520" r="150" fill="#000000" opacity="0.15"/>
    ${lines.map((l, n) => `<text x="34" y="${430 + n * 46}" font-family="DejaVu Sans, sans-serif" font-size="38" font-weight="700" fill="#f8fafc">${esc(l)}</text>`).join('')}
    <text x="34" y="${430 + lines.length * 46 + 14}" font-family="DejaVu Sans, sans-serif" font-size="22" fill="#cbd5e1" opacity="0.85">${year}</text>
  </svg>`;

  await sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toFile(out);
}

async function clean() {
  // Ordered by dependency: children first, then items, then libraries.
  await prisma.mediaArtwork.deleteMany({ where: { item: { library: { name: { startsWith: 'Demo ' } } } } });
  await prisma.mediaMetadata.deleteMany({ where: { item: { library: { name: { startsWith: 'Demo ' } } } } });
  await prisma.mediaFile.deleteMany({ where: { item: { library: { name: { startsWith: 'Demo ' } } } } });
  await prisma.mediaItem.deleteMany({ where: { library: { name: { startsWith: 'Demo ' } } } });
  await prisma.mediaLibrary.deleteMany({ where: { name: { startsWith: 'Demo ' } } });
  console.log('removed demo rows');
}

async function main() {
  assertLocal();
  if (process.argv.includes('--clean')) return clean();

  await clean(); // idempotent re-seed
  await mkdir(join(ROOT, 'art'), { recursive: true });

  const libs = {};
  for (const [name, kind, sub] of [
    ['Demo Movies', 'movie', 'Movies'],
    ['Demo TV Shows', 'tv', 'TV Shows'],
  ]) {
    libs[kind] = await prisma.mediaLibrary.create({
      data: { name, path: join(ROOT, sub), kind, preset: 'plex', mode: 'preview', isEnabled: true },
    });
  }

  let i = 0;
  const mkItem = async ({ lib, title, year, type, season, episode, path, genre }) => {
    const item = await prisma.mediaItem.create({
      data: {
        libraryId: lib.id, path, title, year, mediaType: type,
        season: season ?? null, episode: episode ?? null,
        matchStatus: 'matched', confidence: 0.9 + (i % 9) / 100, locked: false,
      },
    });
    await prisma.mediaFile.create({
      data: {
        itemId: item.id, path, size: BigInt(900_000_000 + (i % 40) * 120_000_000),
        container: 'mkv', videoCodec: i % 3 ? 'h264' : 'hevc', audioCodec: 'eac3',
        resolution: i % 4 ? '1080p' : '2160p', quality: 'BluRay',
      },
    });
    await prisma.mediaMetadata.create({
      data: {
        itemId: item.id, title, year, overview:
          'Placeholder synopsis for documentation. This library is generated and contains no real media.',
        genres: [genre ?? 'drama'], rating: 6.5 + (i % 30) / 10,
      },
    });
    const art = join(ROOT, 'art', `${item.id}.jpg`);
    await poster(title, year, i, art);
    await prisma.mediaArtwork.create({
      data: { itemId: item.id, type: 'poster', localPath: art, selected: true, source: TAG },
    });
    i += 1;
    return item;
  };

  for (const [title, year, genre] of MOVIES) {
    await mkItem({
      lib: libs.movie, title, year, type: 'movie', genre,
      path: join(ROOT, 'Movies', `${title} (${year})`, `${title} (${year}) [1080p].mkv`),
    });
  }

  for (const [show, year, seasons, per] of SHOWS) {
    for (let s = 1; s <= seasons; s += 1) {
      for (let e = 1; e <= per; e += 1) {
        const ep = `S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}`;
        await mkItem({
          lib: libs.tv, title: show, year, type: 'tv', season: s, episode: e, genre: 'drama',
          path: join(ROOT, 'TV Shows', `${show} (${year})`, `Season ${String(s).padStart(2, '0')}`,
            `${show} - ${ep} - Episode ${e}.mkv`),
        });
      }
    }
  }

  const counts = {
    libraries: await prisma.mediaLibrary.count({ where: { name: { startsWith: 'Demo ' } } }),
    items: await prisma.mediaItem.count({ where: { library: { name: { startsWith: 'Demo ' } } } }),
    artwork: await prisma.mediaArtwork.count({ where: { source: TAG } }),
  };
  console.log(JSON.stringify(counts));
}

main()
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
