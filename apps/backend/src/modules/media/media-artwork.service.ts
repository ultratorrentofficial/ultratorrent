import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { mkdir, writeFile, stat, readdir } from 'node:fs/promises';
import { createReadStream, type ReadStream } from 'node:fs';
import * as path from 'node:path';
import sharp from 'sharp';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { FilePathService } from '../files/file-path.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.module';
import { assertSafeOutboundUrl } from '../../common/ssrf';
import type { AuditContext } from './media-metadata.service';
import {
  type ArtworkCandidate,
  TmdbArtworkProvider,
  isAllowedArtworkHost,
  pickBestArtwork,
} from './artwork-provider';

/** Artwork types tracked per item. */
export const ARTWORK_TYPES = [
  'poster',
  'fanart',
  'logo',
  'clearart',
  'banner',
  'thumbnail',
  'season_poster',
  'episode_thumbnail',
] as const;
export type ArtworkType = (typeof ARTWORK_TYPES)[number];

/** Baseline types we expect a fully-decorated movie/show to have. */
const REQUIRED_TYPES: ArtworkType[] = ['poster', 'fanart'];

/** Content types for locally-stored artwork images, keyed by extension. */
const ARTWORK_CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export const MAX_ARTWORK_BYTES = 10 * 1024 * 1024; // 10 MB

/** Width of generated poster thumbnails; height scales to keep aspect. */
export const THUMBNAIL_WIDTH = 400;

/** Image extensions recognised for on-disk sidecar artwork. */
const SIDECAR_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

/** Directory-level sidecar artwork basenames (Kodi/Jellyfin) → artwork type. */
const DIR_ARTWORK_NAMES: Record<string, ArtworkType> = {
  poster: 'poster',
  folder: 'poster',
  cover: 'poster',
  default: 'poster',
  fanart: 'fanart',
  backdrop: 'fanart',
  background: 'fanart',
  art: 'fanart',
  banner: 'banner',
  logo: 'logo',
  clearlogo: 'logo',
  clearart: 'clearart',
  landscape: 'thumbnail',
  thumb: 'thumbnail',
};

/** `<video-basename>-<suffix>.<ext>` sidecar artwork → artwork type. */
const SUFFIX_ARTWORK_NAMES: Record<string, ArtworkType> = {
  poster: 'poster',
  fanart: 'fanart',
  banner: 'banner',
  logo: 'logo',
  clearlogo: 'logo',
  clearart: 'clearart',
  landscape: 'thumbnail',
  thumb: 'thumbnail',
};

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export interface ArtworkUpload {
  type: string;
  filename?: string;
  mime?: string;
  /** base64 (optionally a data: URL) payload of the image. */
  dataBase64: string;
  seasonNumber?: number | null;
}

export interface ValidatedArtwork {
  type: ArtworkType;
  mime: string;
  ext: string;
  buffer: Buffer;
}

/** Sniff an image mime from its magic bytes. Pure — returns null if unknown. */
export function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Validate an artwork upload: allowed type, PNG/JPEG/WEBP only (verified via
 * magic bytes, not just the declared mime), and within the size cap. Pure —
 * exported for unit testing. Throws BadRequestException on any violation.
 */
export function validateArtworkUpload(upload: ArtworkUpload): ValidatedArtwork {
  if (!ARTWORK_TYPES.includes(upload.type as ArtworkType)) {
    throw new BadRequestException(`Unsupported artwork type "${upload.type}".`);
  }
  if (!upload.dataBase64 || typeof upload.dataBase64 !== 'string') {
    throw new BadRequestException('Image data is required.');
  }

  // Accept a data: URL or a raw base64 string.
  const commaIdx = upload.dataBase64.indexOf(',');
  const raw = upload.dataBase64.startsWith('data:')
    ? upload.dataBase64.slice(commaIdx + 1)
    : upload.dataBase64;

  let buffer: Buffer;
  try {
    buffer = Buffer.from(raw, 'base64');
  } catch {
    throw new BadRequestException('Image data is not valid base64.');
  }
  if (buffer.length === 0) {
    throw new BadRequestException('Image data is empty.');
  }
  if (buffer.length > MAX_ARTWORK_BYTES) {
    throw new BadRequestException(
      `Image exceeds the ${Math.round(MAX_ARTWORK_BYTES / 1024 / 1024)}MB limit.`,
    );
  }

  const sniffed = sniffImageMime(buffer);
  if (!sniffed) {
    throw new BadRequestException('Only PNG, JPEG, or WEBP images are allowed.');
  }
  // If the client declared a mime, it must agree with the actual bytes.
  if (upload.mime && upload.mime !== sniffed) {
    throw new BadRequestException(
      `Declared mime "${upload.mime}" does not match image content.`,
    );
  }

  return {
    type: upload.type as ArtworkType,
    mime: sniffed,
    ext: MIME_EXT[sniffed],
    buffer,
  };
}

/**
 * Manages the artwork available/selected for each MediaItem, including custom
 * uploads (validated + stored inside the ops hard roots) and missing-art
 * detection.
 */
/**
 * What a piece of artwork belongs to.
 *
 * Television artwork used to be written onto every episode, so a show's poster
 * was whichever episode's row sorted first and could not be chosen at all. A
 * season is a scope WITHIN a show rather than a third owner, because that is
 * what it is on disk (`season02-poster.jpg` sits in the show folder).
 */
export type ArtworkOwner =
  | { kind: 'item'; itemId: string }
  | { kind: 'show'; showId: string; seasonNumber?: number | null };

@Injectable()
export class MediaArtworkService {
  private readonly logger = new Logger(MediaArtworkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly filePath: FilePathService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  private async requireItem(itemId: string) {
    const item = await this.prisma.mediaItem.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException('Item not found');
    return item;
  }

  private async requireShow(showId: string) {
    const show = await this.prisma.mediaShow.findUnique({ where: { id: showId } });
    if (!show) throw new NotFoundException('Show not found');
    return show;
  }

  /**
   * The rows an owner owns.
   *
   * A season is a show-owned scope, not a third kind of owner: its artwork
   * belongs to the show and carries the season number, which is what lets
   * "season 2's poster" and "the show's poster" coexist without either being a
   * property of some arbitrary episode.
   */
  private ownerWhere(owner: ArtworkOwner): Prisma.MediaArtworkWhereInput {
    if (owner.kind === 'item') return { itemId: owner.itemId };
    return {
      showId: owner.showId,
      // `null` is a real value here — show-level artwork is exactly the rows
      // with no season — so this must not degrade into "any season".
      seasonNumber: owner.seasonNumber ?? null,
    };
  }

  /** The columns that make a new row belong to this owner. */
  private ownerData(owner: ArtworkOwner): { itemId?: string; showId?: string; seasonNumber?: number | null } {
    return owner.kind === 'item'
      ? { itemId: owner.itemId }
      : { showId: owner.showId, seasonNumber: owner.seasonNumber ?? null };
  }

  /** Where an owner's uploaded files live. Distinct per owner, never shared. */
  private ownerDirKey(owner: ArtworkOwner): string {
    if (owner.kind === 'item') return owner.itemId;
    return owner.seasonNumber == null
      ? `show-${owner.showId}`
      : `show-${owner.showId}-s${owner.seasonNumber}`;
  }

  private async requireOwner(owner: ArtworkOwner) {
    if (owner.kind === 'item') await this.requireItem(owner.itemId);
    else await this.requireShow(owner.showId);
  }

  /**
   * Import artwork that already sits next to the item's media file — Kodi/
   * Jellyfin sidecars like `poster.jpg`, `fanart.jpg`, `folder.jpg`, and
   * `<video-name>-poster.jpg`. Files are referenced in place (their on-disk
   * path becomes `localPath`, `source: 'local'`) rather than copied, exactly
   * like subtitle sidecars. Idempotent per `localPath`; a type is auto-selected
   * only when nothing of that type is selected yet, so operator choices stand.
   * Returns the number of new artwork rows created.
   */
  async importLocal(itemId: string): Promise<number> {
    const item = await this.prisma.mediaItem.findUnique({
      where: { id: itemId },
      include: { files: true, artwork: true, library: true },
    });
    if (!item) return 0;

    const known = new Set(
      item.artwork.map((a) => a.localPath).filter((p): p is string => Boolean(p)),
    );
    const selectedTypes = new Set(item.artwork.filter((a) => a.selected).map((a) => a.type));

    const basenames = new Set<string>();
    for (const f of item.files) {
      basenames.add(path.basename(f.path, path.extname(f.path)).toLowerCase());
    }
    // Scan each file's own directory AND its ancestors up to the library root:
    // TV show/season artwork (poster.jpg, fanart.jpg, season01-poster.jpg, …)
    // lives in the show root, one or more levels above the episode file.
    const dirs = this.artworkSearchDirs(item.files.map((f) => f.path), item.library?.path);

    // Collect candidate {localPath -> {type, seasonNumber}}, de-duplicated.
    const candidates = new Map<string, { type: ArtworkType; seasonNumber: number | null }>();
    for (const dir of dirs) {
      let safeDir: string;
      try {
        safeDir = this.filePath.assertWithinHardRoots(dir);
      } catch {
        continue; // outside the storage roots — skip
      }
      let entries: import('node:fs').Dirent[];
      try {
        entries = await readdir(safeDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!SIDECAR_IMAGE_EXTS.has(ext)) continue;
        const name = path.basename(entry.name, ext).toLowerCase();
        const classified = this.classifySidecarArtwork(name, basenames);
        if (!classified) continue;
        const full = path.join(safeDir, entry.name);
        if (known.has(full) || candidates.has(full)) continue;
        candidates.set(full, classified);
      }
    }

    let created = 0;
    for (const [localPath, { type, seasonNumber }] of candidates) {
      const selected = !selectedTypes.has(type);
      await this.prisma.mediaArtwork.create({
        data: { itemId, type, localPath, source: 'local', selected, seasonNumber },
      });
      if (selected) selectedTypes.add(type);
      created++;
    }
    return created;
  }

  /**
   * Directories to scan for an item's sidecar artwork: each media file's own
   * directory plus every ancestor up to (and including) the library root. This
   * is what lets a TV episode in `Show/Season 01/` pick up the show-level
   * `poster.jpg`/`fanart.jpg` that sit in `Show/`. Bounded by the library root
   * so it never climbs into unrelated parts of the filesystem.
   */
  private artworkSearchDirs(filePaths: string[], libraryRoot?: string | null): Set<string> {
    const dirs = new Set<string>();
    const root = libraryRoot ? path.resolve(libraryRoot) : null;
    for (const fp of filePaths) {
      let cur = path.resolve(path.dirname(fp));
      dirs.add(cur);
      if (!root || !(cur === root || cur.startsWith(root + path.sep))) continue;
      while (cur !== root) {
        const parent = path.dirname(cur);
        if (parent === cur) break; // hit the filesystem root — stop
        cur = parent;
        dirs.add(cur);
        if (cur === root) break;
      }
    }
    return dirs;
  }

  /**
   * Register a show folder's own artwork against the SHOW.
   *
   * `poster.jpg`, `banner.jpg`, `fanart.jpg`, `clearlogo.png` and
   * `seasonNN-poster.jpg` describe the series, not any one episode — a season
   * poster describes a season. Files are referenced where they lie, exactly as
   * the item-level sidecar import does, so nothing is copied and a re-scan is
   * idempotent per path.
   *
   * Auto-selection only fills a gap: a type already chosen for that scope is
   * left alone, because a scan must never overrule the operator.
   */
  async importShowFolder(showId: string, dir: string): Promise<number> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    let created = 0;

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!SIDECAR_IMAGE_EXTS.has(ext)) continue;
      const name = path.basename(entry.name, ext).toLowerCase();
      // No video basenames here: a show folder's images belong to the show, and
      // `<episode>-thumb.jpg` lives beside its episode inside a season folder.
      const hit = this.classifySidecarArtwork(name, new Set());
      if (!hit) continue;

      const localPath = path.join(dir, entry.name);
      const existing = await this.prisma.mediaArtwork.findFirst({ where: { showId, localPath } });
      if (existing) continue;

      const scope = { showId, seasonNumber: hit.seasonNumber };
      const hasSelected = await this.prisma.mediaArtwork.findFirst({
        where: { ...scope, type: hit.type, selected: true },
      });
      await this.prisma.mediaArtwork.create({
        data: {
          ...scope,
          type: hit.type,
          localPath,
          source: 'local',
          selected: !hasSelected,
        },
      });
      created += 1;
    }
    return created;
  }

  /**
   * Map a sidecar image basename to an artwork type (+ season number for season
   * posters), or null if unrecognised.
   */
  private classifySidecarArtwork(
    name: string,
    videoBasenames: Set<string>,
  ): { type: ArtworkType; seasonNumber: number | null } | null {
    // Season poster: "season01-poster", "season1-poster", or bare "season01".
    const seasonMatch =
      /^season[\s._-]*(\d{1,3})[\s._-]*poster$/.exec(name) ?? /^season[\s._-]*(\d{1,3})$/.exec(name);
    if (seasonMatch) return { type: 'season_poster', seasonNumber: Number(seasonMatch[1]) };
    const direct = DIR_ARTWORK_NAMES[name];
    if (direct) return { type: direct, seasonNumber: null };
    for (const base of videoBasenames) {
      if (name.startsWith(`${base}-`)) {
        const suffix = name.slice(base.length + 1);
        if (SUFFIX_ARTWORK_NAMES[suffix]) {
          return { type: SUFFIX_ARTWORK_NAMES[suffix], seasonNumber: null };
        }
      }
    }
    return null;
  }

  /**
   * Open a locally-stored artwork image (custom uploads + provider imports that
   * were downloaded to disk) for streaming. Remote-only artwork — art that has a
   * `url` but no `localPath` — is served directly from that URL by the client
   * and never routed here. The path is re-asserted inside the hard roots.
   */
  async readImage(
    artworkId: string,
  ): Promise<{ stream: ReadStream; contentType: string; size: number }> {
    const art = await this.prisma.mediaArtwork.findUnique({ where: { id: artworkId } });
    if (!art) throw new NotFoundException('Artwork not found');
    if (!art.localPath) {
      throw new NotFoundException('This artwork has no locally stored image.');
    }
    const safe = this.filePath.assertWithinHardRoots(art.localPath);
    const st = await stat(safe).catch(() => null);
    if (!st || !st.isFile()) {
      throw new NotFoundException('The artwork image file is missing.');
    }
    return {
      stream: createReadStream(safe),
      contentType: ARTWORK_CONTENT_TYPES[path.extname(safe).toLowerCase()] ?? 'application/octet-stream',
      size: st.size,
    };
  }

  /**
   * Serve a small, cached WebP thumbnail of a locally-stored artwork image, for
   * fast grid rendering (full-size posters can be several MB). Generated lazily
   * on first request and cached under `.ultratorrent/media-artwork/thumbs/`
   * (a dot-dir the scanner ignores); regenerated when the source is newer. If
   * resizing fails (corrupt/unsupported image) it falls back to the original so
   * the poster still renders rather than reverting to the stub.
   */
  async thumbnail(
    artworkId: string,
  ): Promise<{ stream: ReadStream; contentType: string; size: number }> {
    const art = await this.prisma.mediaArtwork.findUnique({ where: { id: artworkId } });
    if (!art) throw new NotFoundException('Artwork not found');
    if (!art.localPath) {
      throw new NotFoundException('This artwork has no locally stored image.');
    }
    const source = this.filePath.assertWithinHardRoots(art.localPath);
    const srcStat = await stat(source).catch(() => null);
    if (!srcStat || !srcStat.isFile()) {
      throw new NotFoundException('The artwork image file is missing.');
    }

    const root = this.filePath.hardRoots[0];
    if (!root) throw new BadRequestException('No storage root is configured.');
    const cacheDir = path.join(root, '.ultratorrent', 'media-artwork', 'thumbs');
    const cachePath = this.filePath.assertWithinHardRoots(
      path.join(cacheDir, `${artworkId}.webp`),
    );

    try {
      // (Re)generate when the cache is missing or older than the source image.
      const cacheStat = await stat(cachePath).catch(() => null);
      if (!cacheStat || cacheStat.mtimeMs < srcStat.mtimeMs) {
        await mkdir(cacheDir, { recursive: true });
        const buf = await sharp(source)
          .rotate() // honour EXIF orientation
          .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
          .webp({ quality: 78 })
          .toBuffer();
        await writeFile(cachePath, buf);
      }
      const finalStat = await stat(cachePath);
      return {
        stream: createReadStream(cachePath),
        contentType: 'image/webp',
        size: finalStat.size,
      };
    } catch {
      // Thumbnailing failed — serve the original so the image still shows.
      return this.readImage(artworkId);
    }
  }

  /** List an item's artwork with the current selection per type. */
  async list(itemId: string) {
    const { artwork, selected } = await this.listFor({ kind: 'item', itemId });
    return { itemId, artwork, selected };
  }

  /** Everything an owner has, and which row is the chosen one per type. */
  async listFor(owner: ArtworkOwner) {
    await this.requireOwner(owner);
    const artwork = await this.prisma.mediaArtwork.findMany({
      where: this.ownerWhere(owner),
      orderBy: [{ type: 'asc' }, { selected: 'desc' }],
    });
    const selected: Record<string, string> = {};
    for (const a of artwork) if (a.selected) selected[a.type] = a.id;
    return { owner, artwork, selected };
  }

  /** Mark one artwork as selected for its type (unselecting the others). */
  async select(itemId: string, artworkId: string, ctx: AuditContext = {}) {
    return this.selectFor({ kind: 'item', itemId }, artworkId, ctx);
  }

  /**
   * Make one row the chosen artwork for its type, within its owner's scope.
   *
   * The unselect is scoped by OWNER, not by type alone: unselecting every
   * poster of a type across the table would clear the show's choice when a
   * season's is set, and vice versa.
   */
  async selectFor(owner: ArtworkOwner, artworkId: string, ctx: AuditContext = {}) {
    await this.requireOwner(owner);
    const scope = this.ownerWhere(owner);
    const art = await this.prisma.mediaArtwork.findFirst({
      where: { id: artworkId, ...scope },
    });
    if (!art) throw new NotFoundException('Artwork not found');

    await this.prisma.$transaction([
      this.prisma.mediaArtwork.updateMany({
        where: { ...scope, type: art.type },
        data: { selected: false },
      }),
      this.prisma.mediaArtwork.update({
        where: { id: artworkId },
        data: { selected: true },
      }),
    ]);

    await this.audit.record({
      userId: ctx.userId,
      action: 'media.artwork.select',
      // The audit row names what was actually acted on: a show-scoped choice
      // recorded against a media_item would point at nothing.
      objectType: owner.kind === 'item' ? 'media_item' : 'media_show',
      objectId: owner.kind === 'item' ? owner.itemId : owner.showId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: {
        type: art.type,
        artworkId,
        ...(owner.kind === 'show' && owner.seasonNumber != null
          ? { seasonNumber: owner.seasonNumber }
          : {}),
      },
    });

    return this.listFor(owner);
  }

  /** Validate + store a custom uploaded image and record it as artwork. */
  async uploadCustom(itemId: string, upload: ArtworkUpload, ctx: AuditContext = {}) {
    return this.uploadFor({ kind: 'item', itemId }, upload, ctx);
  }

  /** Store an operator-supplied image as this owner's artwork, and select it. */
  async uploadFor(owner: ArtworkOwner, upload: ArtworkUpload, ctx: AuditContext = {}) {
    await this.requireOwner(owner);
    const valid = validateArtworkUpload(upload);

    const root = this.filePath.hardRoots[0];
    if (!root) {
      throw new BadRequestException('No storage root is configured.');
    }
    const dir = path.join(root, '.ultratorrent', 'media-artwork', this.ownerDirKey(owner));
    const filename = `${valid.type}-${Date.now()}.${valid.ext}`;
    const dest = path.join(dir, filename);
    // Enforce containment even though we built the path ourselves.
    const safeDest = this.filePath.assertWithinHardRoots(dest);

    await mkdir(path.dirname(safeDest), { recursive: true });
    await writeFile(safeDest, valid.buffer);

    // A custom upload becomes the selected art for its type, within this
    // owner's scope only.
    await this.prisma.mediaArtwork.updateMany({
      where: { ...this.ownerWhere(owner), type: valid.type },
      data: { selected: false },
    });
    const artwork = await this.prisma.mediaArtwork.create({
      data: {
        ...this.ownerData(owner),
        type: valid.type,
        localPath: safeDest,
        source: 'custom',
        selected: true,
        /*
         * The OWNER's season wins. `ownerData` already scoped this row, and
         * letting the upload body re-specify it would let a season-scoped
         * request land its file outside that season — the one place the two
         * could disagree.
         */
        ...(owner.kind === 'item' ? { seasonNumber: upload.seasonNumber ?? null } : {}),
      },
    });

    await this.audit.record({
      userId: ctx.userId,
      action: 'media.artwork.upload',
      objectType: owner.kind === 'item' ? 'media_item' : 'media_show',
      objectId: owner.kind === 'item' ? owner.itemId : owner.showId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: {
        type: valid.type,
        mime: valid.mime,
        bytes: valid.buffer.length,
        ...(owner.kind === 'show' && owner.seasonNumber != null
          ? { seasonNumber: owner.seasonNumber }
          : {}),
      },
    });

    return artwork;
  }

  /**
   * Fetch baseline artwork (poster + fanart) from an online provider and store
   * it locally. Falls back to detectMissing() when no provider is configured or
   * the item has no external id, preserving the "report the gap" behaviour.
   */
  async importFromProvider(itemId: string, ctx: AuditContext = {}) {
    const item = await this.requireItem(itemId);
    const ext = await this.prisma.mediaExternalId.findUnique({
      where: { itemId_provider: { itemId, provider: 'tmdb' } },
    });
    const kind = item.mediaType === 'movie' ? 'movie' : 'tv'; // tv/anime → tv
    const done = await this.importFor({ kind: 'item', itemId }, kind, ext?.externalId ?? null, ctx);
    /*
     * An episode also gets its own still. `/tv/{id}/images` holds the SERIES'
     * posters and backdrops and nothing about episode 4, so without this an
     * episode's artwork could only ever be its show's.
     */
    if (kind === 'tv' && item.season != null && item.episode != null && ext?.externalId) {
      await this.importEpisodeStill(itemId, ext.externalId, item.season, item.episode);
    }
    return done ?? this.detectMissing(itemId);
  }

  /** Best-effort: a missing still must not fail the artwork import around it. */
  private async importEpisodeStill(
    itemId: string,
    seriesId: string,
    season: number,
    episode: number,
  ): Promise<void> {
    const key =
      (await this.settings.get<string>('media.tmdbApiKey')) ?? process.env.TMDB_API_KEY;
    if (!key) return;
    try {
      const stills = await new TmdbArtworkProvider(key).listEpisodeStills(seriesId, season, episode);
      const best = pickBestArtwork(stills, 'thumbnail');
      if (best) await this.downloadAndStore({ kind: 'item', itemId }, best);
    } catch (err) {
      this.logger.warn(`Episode still import failed for ${itemId}: ${(err as Error).message}`);
    }
  }

  /**
   * Pull artwork for a SHOW from the provider.
   *
   * The series' own TMDB id, not an episode's: a show has no item to borrow one
   * from, which is why `MediaShow.tmdbId` exists. Resolved on demand when it is
   * missing, so an operator who never ran a metadata refresh still gets art.
   */
  async importForShow(showId: string, ctx: AuditContext = {}, seasonNumber?: number | null) {
    const show = await this.requireShow(showId);
    const owner: ArtworkOwner = { kind: 'show', showId, seasonNumber: seasonNumber ?? null };

    /*
     * A season's cover comes from a different endpoint.
     *
     * `/tv/{id}/images` holds the SERIES' posters and knows nothing about
     * season 2, so a season scope asking it received the show's art — filed
     * under the season, while the season cover itself never arrived. Reported
     * as "fetch artwork is not downloading the season cover artwork".
     */
    if (seasonNumber != null) {
      return this.importSeasonPosters(show.id, show.tmdbId, seasonNumber, owner, ctx);
    }

    const done = await this.importFor(owner, 'tv', show.tmdbId, ctx);
    return done ?? { showId, provider: 'tmdb', imported: [], reason: 'no_provider_id' };
  }

  private async importSeasonPosters(
    showId: string,
    tmdbId: string | null,
    seasonNumber: number,
    owner: ArtworkOwner,
    ctx: AuditContext,
  ) {
    const key =
      (await this.settings.get<string>('media.tmdbApiKey')) ?? process.env.TMDB_API_KEY;
    if (!key || !tmdbId) {
      return { showId, provider: 'tmdb', imported: [], reason: 'no_provider_id' as const };
    }
    const candidates = await new TmdbArtworkProvider(key).listSeasonPosters(tmdbId, seasonNumber);
    const best = pickBestArtwork(candidates, 'season_poster');
    const imported: ArtworkType[] = [];
    if (best && (await this.downloadAndStore(owner, best))) imported.push('season_poster');

    await this.audit.record({
      userId: ctx.userId,
      action: 'media.artwork.import',
      objectType: 'media_show',
      objectId: showId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { provider: 'tmdb', imported, seasonNumber },
    });
    return { showId, provider: 'tmdb', imported, seasonNumber };
  }

  /**
   * The shared import. Returns null when it cannot run at all — no API key, or
   * no provider id for this owner — so the caller decides what that means:
   * an item reports its missing types, a show says why it could not.
   */
  private async importFor(
    owner: ArtworkOwner,
    kind: 'movie' | 'tv',
    externalId: string | null,
    ctx: AuditContext = {},
  ) {
    const key =
      (await this.settings.get<string>('media.tmdbApiKey')) ?? process.env.TMDB_API_KEY;
    if (!key || !externalId) return null;

    const provider = new TmdbArtworkProvider(key);
    const candidates = await provider.list(kind, externalId);

    const imported: ArtworkType[] = [];
    for (const type of REQUIRED_TYPES) {
      const cand = pickBestArtwork(candidates, type);
      if (!cand) continue;
      const art = await this.downloadAndStore(owner, cand);
      if (art) imported.push(type);
    }

    await this.audit.record({
      userId: ctx.userId,
      action: 'media.artwork.import',
      objectType: owner.kind === 'item' ? 'media_item' : 'media_show',
      objectId: owner.kind === 'item' ? owner.itemId : owner.showId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { provider: 'tmdb', imported },
    });

    return owner.kind === 'item'
      ? { itemId: owner.itemId, provider: 'tmdb', imported }
      : { showId: owner.showId, provider: 'tmdb', imported };
  }

  /**
   * Download a provider candidate, validate it through the same magic-byte +
   * size checks as uploads, store it under the hard root, and record the row.
   * Idempotent per url. Returns null (skips) on any fetch/validation failure.
   */
  private async downloadAndStore(owner: ArtworkOwner, cand: ArtworkCandidate) {
    if (!isAllowedArtworkHost(cand.url)) {
      throw new BadRequestException(`Refusing to fetch artwork from "${cand.url}".`);
    }

    // Idempotency: don't re-download art we already have from this url — per
    // owner, so a show and one of its episodes may each hold the same image.
    const existing = await this.prisma.mediaArtwork.findFirst({
      where: { ...this.ownerWhere(owner), url: cand.url },
    });
    if (existing) return existing;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let buffer: Buffer;
    try {
      // SSRF guard: cand.url comes from a provider response (TMDB/TVDB/media-server),
      // so a poisoned response could otherwise steer this fetch to an internal
      // address. Blocks internal hosts + redirects; throws → caught → null (best-effort).
      const safe = await assertSafeOutboundUrl(cand.url);
      const res = await fetch(safe.toString(), { redirect: 'error', signal: ctrl.signal });
      if (!res.ok) return null;
      buffer = Buffer.from(await res.arrayBuffer());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }

    if (buffer.length === 0 || buffer.length > MAX_ARTWORK_BYTES) return null;
    const mime = sniffImageMime(buffer);
    if (!mime) return null; // provider served a non-image / unsupported format

    const root = this.filePath.hardRoots[0];
    if (!root) throw new BadRequestException('No storage root is configured.');
    const dir = path.join(root, '.ultratorrent', 'media-artwork', this.ownerDirKey(owner));
    const dest = this.filePath.assertWithinHardRoots(
      path.join(dir, `${cand.type}-${Date.now()}.${MIME_EXT[mime]}`),
    );
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, buffer);

    // Auto-select only when the item has no art of this type yet, so an
    // operator's custom upload always keeps precedence.
    const hasSelected = await this.prisma.mediaArtwork.findFirst({
      where: { ...this.ownerWhere(owner), type: cand.type, selected: true },
      select: { id: true },
    });

    return this.prisma.mediaArtwork.create({
      data: {
        ...this.ownerData(owner),
        type: cand.type,
        localPath: dest,
        url: cand.url,
        source: 'tmdb',
        selected: !hasSelected,
        width: cand.width ?? null,
        height: cand.height ?? null,
        seasonNumber: cand.seasonNumber ?? null,
      },
    });
  }

  /** Report which baseline artwork types an item is missing. */
  async detectMissing(itemId: string) {
    await this.requireItem(itemId);
    const present = await this.prisma.mediaArtwork.findMany({
      where: { itemId },
      select: { type: true },
    });
    const have = new Set(present.map((p) => p.type));
    const missing = REQUIRED_TYPES.filter((t) => !have.has(t));
    return { itemId, present: [...have], missing };
  }
}
