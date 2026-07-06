import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SecretCipher } from '../../common/crypto/secret-cipher';

const IMG_KEY = 'media_server_analytics.newsletter_images';
const POSTER_TARGET_WIDTH = 240; // downscale target — the card slot is ~84–120px
const MAX_RAW_POSTER_BYTES = 12 * 1024 * 1024; // guard before handing a file to sharp
const MAX_POSTER_BYTES = 500 * 1024; // fallback cap when resizing is skipped
const TOKEN_TTL_MS = 45 * 24 * 60 * 60 * 1000; // signed image URLs valid ~45 days

/** How newsletter posters reach the reader's inbox. */
export type PosterHostingMode = 'attach' | 'self_hosted' | 'external';

interface ImageConfig {
  mode?: PosterHostingMode;
  publicBaseUrl?: string; // self_hosted: externally-reachable base, e.g. http://host
  externalProvider?: 'imgur';
  encryptedImgurClientId?: string;
}

export interface PosterArt {
  id: string;
  url: string | null;
  localPath: string | null;
}

/**
 * Newsletter poster hosting: the admin chooses how images reach the inbox —
 * embedded (CID attachments, self-contained), served from this instance (a
 * signed, public, tokenized image URL — no attachments, no library paths
 * leaked), or uploaded to an external image host (Imgur). This service owns the
 * settings, the HMAC-signed URL tokens, poster downscaling, and the endpoint's
 * on-demand image loader.
 */
@Injectable()
export class NewsletterImageService {
  private readonly logger = new Logger(NewsletterImageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: SecretCipher,
    private readonly config: ConfigService,
  ) {}

  // --- settings ------------------------------------------------------------
  private async raw(): Promise<ImageConfig> {
    const row = await this.prisma.setting.findUnique({ where: { key: IMG_KEY } });
    return (row?.value as ImageConfig) ?? {};
  }

  /** Redacted settings (never returns the Imgur client id). */
  async getSettings() {
    const cfg = await this.raw();
    return {
      mode: cfg.mode ?? ('attach' as PosterHostingMode),
      publicBaseUrl: cfg.publicBaseUrl ?? '',
      externalProvider: cfg.externalProvider ?? ('imgur' as const),
      hasImgurClientId: Boolean(cfg.encryptedImgurClientId),
    };
  }

  async updateSettings(input: {
    mode?: PosterHostingMode;
    publicBaseUrl?: string;
    externalProvider?: 'imgur';
    imgurClientId?: string;
  }) {
    const cur = await this.raw();
    const next: ImageConfig = {
      ...cur,
      mode: input.mode ?? cur.mode,
      publicBaseUrl: input.publicBaseUrl !== undefined ? input.publicBaseUrl.trim().replace(/\/+$/, '') : cur.publicBaseUrl,
      externalProvider: input.externalProvider ?? cur.externalProvider,
    };
    if (input.imgurClientId && !/^•+$/.test(input.imgurClientId)) next.encryptedImgurClientId = this.cipher.encrypt(input.imgurClientId.trim());
    await this.prisma.setting.upsert({
      where: { key: IMG_KEY },
      create: { key: IMG_KEY, value: next as object },
      update: { value: next as object },
    });
    return this.getSettings();
  }

  /**
   * The mode that will actually be used, downgraded to `attach` when the chosen
   * mode is missing its required config (so a send never silently produces
   * broken images).
   */
  async effectiveMode(): Promise<{ mode: PosterHostingMode; publicBaseUrl?: string }> {
    const cfg = await this.raw();
    const mode = cfg.mode ?? 'attach';
    if (mode === 'self_hosted' && !cfg.publicBaseUrl) return { mode: 'attach' };
    if (mode === 'external' && !cfg.encryptedImgurClientId) return { mode: 'attach' };
    return { mode, publicBaseUrl: cfg.publicBaseUrl };
  }

  // --- signed self-hosted URLs --------------------------------------------
  private secret(): string {
    return this.config.get<string>('jwt.accessSecret') ?? '';
  }

  private sign(artworkId: string, exp: number): string {
    return createHmac('sha256', this.secret()).update(`${artworkId}.${exp}`).digest('base64url');
  }

  /** Public, tokenized image URL for a piece of artwork (self-hosted mode). */
  imageUrl(base: string, artworkId: string): string {
    const exp = Date.now() + TOKEN_TTL_MS;
    const s = this.sign(artworkId, exp);
    return `${base}/api/media-server-analytics/nl-image/${artworkId}?e=${exp}&s=${s}`;
  }

  /** Constant-time verification of a signed image URL. */
  verify(artworkId: string, e?: string, s?: string): boolean {
    if (!e || !s) return false;
    const exp = Number(e);
    if (!Number.isFinite(exp) || exp < Date.now()) return false;
    const expected = Buffer.from(this.sign(artworkId, exp));
    const given = Buffer.from(s);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  // --- image bytes ---------------------------------------------------------
  /** Read a poster (URL or local file) and downscale it to a small JPEG. */
  async loadAndResize(art: { url: string | null; localPath: string | null }): Promise<{ buf: Buffer; contentType: string } | null> {
    try {
      let rawImg: Buffer | null = null;
      if (art.url) {
        const res = await fetch(art.url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return null;
        if (!(res.headers.get('content-type') ?? '').startsWith('image/')) return null;
        rawImg = Buffer.from(await res.arrayBuffer());
      } else if (art.localPath) {
        rawImg = await readFile(art.localPath);
      }
      if (!rawImg || rawImg.length === 0 || rawImg.length > MAX_RAW_POSTER_BYTES) return null;
      try {
        const buf = await sharp(rawImg).rotate().resize({ width: POSTER_TARGET_WIDTH, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
        return { buf, contentType: 'image/jpeg' };
      } catch {
        if (rawImg.length > MAX_POSTER_BYTES) return null;
        return { buf: rawImg, contentType: art.localPath?.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg' };
      }
    } catch {
      return null; // best-effort — never block a send
    }
  }

  /** Load + downscale the image for a MediaArtwork id (used by the public endpoint). */
  async loadArtworkImage(artworkId: string): Promise<{ buf: Buffer; contentType: string } | null> {
    const art = await this.prisma.mediaArtwork.findUnique({ where: { id: artworkId }, select: { url: true, localPath: true } });
    if (!art) return null;
    return this.loadAndResize(art);
  }

  // --- external host (Imgur) ----------------------------------------------
  async uploadExternal(buf: Buffer): Promise<string | null> {
    const cfg = await this.raw();
    if (!cfg.encryptedImgurClientId) return null;
    try {
      const clientId = this.cipher.decrypt(cfg.encryptedImgurClientId);
      const res = await fetch('https://api.imgur.com/3/image', {
        method: 'POST',
        headers: { Authorization: `Client-ID ${clientId}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: buf.toString('base64'), type: 'base64' }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        this.logger.warn(`Imgur upload failed: ${res.status}`);
        return null;
      }
      const json = (await res.json()) as { data?: { link?: string } };
      return json.data?.link ?? null;
    } catch (e) {
      this.logger.warn(`Imgur upload error: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }
}
