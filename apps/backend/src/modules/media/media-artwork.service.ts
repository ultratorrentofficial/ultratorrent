import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { createReadStream, type ReadStream } from 'node:fs';
import * as path from 'node:path';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { FilePathService } from '../files/file-path.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.module';
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
@Injectable()
export class MediaArtworkService {
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

  /** List an item's artwork with the current selection per type. */
  async list(itemId: string) {
    await this.requireItem(itemId);
    const artwork = await this.prisma.mediaArtwork.findMany({
      where: { itemId },
      orderBy: [{ type: 'asc' }, { selected: 'desc' }],
    });
    const selected: Record<string, string> = {};
    for (const a of artwork) if (a.selected) selected[a.type] = a.id;
    return { itemId, artwork, selected };
  }

  /** Mark one artwork as selected for its type (unselecting the others). */
  async select(itemId: string, artworkId: string, ctx: AuditContext = {}) {
    await this.requireItem(itemId);
    const art = await this.prisma.mediaArtwork.findFirst({
      where: { id: artworkId, itemId },
    });
    if (!art) throw new NotFoundException('Artwork not found');

    await this.prisma.$transaction([
      this.prisma.mediaArtwork.updateMany({
        where: { itemId, type: art.type },
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
      objectType: 'media_item',
      objectId: itemId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { type: art.type, artworkId },
    });

    return this.list(itemId);
  }

  /** Validate + store a custom uploaded image and record it as artwork. */
  async uploadCustom(itemId: string, upload: ArtworkUpload, ctx: AuditContext = {}) {
    await this.requireItem(itemId);
    const valid = validateArtworkUpload(upload);

    const root = this.filePath.hardRoots[0];
    if (!root) {
      throw new BadRequestException('No storage root is configured.');
    }
    const dir = path.join(root, '.ultratorrent', 'media-artwork', itemId);
    const filename = `${valid.type}-${Date.now()}.${valid.ext}`;
    const dest = path.join(dir, filename);
    // Enforce containment even though we built the path ourselves.
    const safeDest = this.filePath.assertWithinHardRoots(dest);

    await mkdir(path.dirname(safeDest), { recursive: true });
    await writeFile(safeDest, valid.buffer);

    // A custom upload becomes the selected art for its type.
    await this.prisma.mediaArtwork.updateMany({
      where: { itemId, type: valid.type },
      data: { selected: false },
    });
    const artwork = await this.prisma.mediaArtwork.create({
      data: {
        itemId,
        type: valid.type,
        localPath: safeDest,
        source: 'custom',
        selected: true,
        seasonNumber: upload.seasonNumber ?? null,
      },
    });

    await this.audit.record({
      userId: ctx.userId,
      action: 'media.artwork.upload',
      objectType: 'media_item',
      objectId: itemId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { type: valid.type, mime: valid.mime, bytes: valid.buffer.length },
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

    const key =
      (await this.settings.get<string>('media.tmdbApiKey')) ?? process.env.TMDB_API_KEY;
    if (!key) return this.detectMissing(itemId);

    const ext = await this.prisma.mediaExternalId.findUnique({
      where: { itemId_provider: { itemId, provider: 'tmdb' } },
    });
    if (!ext) return this.detectMissing(itemId);

    const kind = item.mediaType === 'movie' ? 'movie' : 'tv'; // tv/anime → tv
    const provider = new TmdbArtworkProvider(key);
    const candidates = await provider.list(kind, ext.externalId);

    const imported: ArtworkType[] = [];
    for (const type of REQUIRED_TYPES) {
      const cand = pickBestArtwork(candidates, type);
      if (!cand) continue;
      const art = await this.downloadAndStore(itemId, cand);
      if (art) imported.push(type);
    }

    await this.audit.record({
      userId: ctx.userId,
      action: 'media.artwork.import',
      objectType: 'media_item',
      objectId: itemId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { provider: 'tmdb', imported },
    });

    return { itemId, provider: 'tmdb', imported };
  }

  /**
   * Download a provider candidate, validate it through the same magic-byte +
   * size checks as uploads, store it under the hard root, and record the row.
   * Idempotent per url. Returns null (skips) on any fetch/validation failure.
   */
  private async downloadAndStore(itemId: string, cand: ArtworkCandidate) {
    if (!isAllowedArtworkHost(cand.url)) {
      throw new BadRequestException(`Refusing to fetch artwork from "${cand.url}".`);
    }

    // Idempotency: don't re-download art we already have from this url.
    const existing = await this.prisma.mediaArtwork.findFirst({
      where: { itemId, url: cand.url },
    });
    if (existing) return existing;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let buffer: Buffer;
    try {
      const res = await fetch(cand.url, { signal: ctrl.signal });
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
    const dir = path.join(root, '.ultratorrent', 'media-artwork', itemId);
    const dest = this.filePath.assertWithinHardRoots(
      path.join(dir, `${cand.type}-${Date.now()}.${MIME_EXT[mime]}`),
    );
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, buffer);

    // Auto-select only when the item has no art of this type yet, so an
    // operator's custom upload always keeps precedence.
    const hasSelected = await this.prisma.mediaArtwork.findFirst({
      where: { itemId, type: cand.type, selected: true },
      select: { id: true },
    });

    return this.prisma.mediaArtwork.create({
      data: {
        itemId,
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
