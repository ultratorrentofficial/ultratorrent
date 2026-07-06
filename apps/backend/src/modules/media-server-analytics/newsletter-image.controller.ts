import { Controller, Get, NotFoundException, Param, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { NewsletterImageService } from './newsletter-image.service';

/**
 * Public, unauthenticated poster images for self-hosted newsletter delivery.
 * Deliberately NOT under the module's auth guards — mail clients (and Gmail's
 * image proxy) can't send a bearer token. Access is gated by a per-image
 * HMAC-signed, expiring token instead, and only ever serves a downscaled
 * `MediaArtwork` row by id (no arbitrary files, no library paths in the URL).
 */
@Controller('media-server-analytics/nl-image')
export class NewsletterImageController {
  constructor(private readonly images: NewsletterImageService) {}

  @Get(':id')
  async serve(
    @Param('id') id: string,
    @Query('e') e: string,
    @Query('s') s: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    // 404 (not 403) on a bad/expired token so the endpoint reveals nothing.
    if (!this.images.verify(id, e, s)) throw new NotFoundException();
    const img = await this.images.loadArtworkImage(id);
    if (!img) throw new NotFoundException();
    res.set({ 'Content-Type': img.contentType, 'Cache-Control': 'public, max-age=86400' });
    return new StreamableFile(img.buf);
  }
}
