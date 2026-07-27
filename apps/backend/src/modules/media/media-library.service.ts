import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { FilePathService } from '../files/file-path.service';
import { MediaDuplicateService } from './media-duplicate.service';

export interface LibraryInput {
  name?: string;
  path?: string;
  kind?: string;
  preset?: string;
  template?: string | null;
  mode?: string;
  isEnabled?: boolean;
  scanIntervalMinutes?: number | null;
  nfoEnabled?: boolean;
  artworkEnabled?: boolean;
}

/**
 * CRUD for Media Manager libraries. A library is a root folder plus the scan +
 * naming configuration used when its contents are scanned and organised.
 */
@Injectable()
export class MediaLibraryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly filePath: FilePathService,
    private readonly duplicates: MediaDuplicateService,
  ) {}

  list() {
    return this.prisma.mediaLibrary.findMany({ orderBy: { createdAt: 'asc' } });
  }

  async get(id: string) {
    const lib = await this.prisma.mediaLibrary.findUnique({ where: { id } });
    if (!lib) throw new NotFoundException('Library not found');
    return lib;
  }

  create(data: LibraryInput) {
    if (!data?.name || !data?.path) {
      throw new BadRequestException('name and path are required');
    }
    // A library path must live inside the ops-controlled storage roots.
    const safePath = this.filePath.assertWithinHardRoots(data.path);
    return this.prisma.mediaLibrary.create({
      data: {
        name: data.name,
        path: safePath,
        kind: data.kind ?? 'tv',
        preset: data.preset ?? 'plex',
        template: data.template ?? null,
        mode: data.mode ?? 'hardlink',
        isEnabled: data.isEnabled ?? true,
        scanIntervalMinutes: data.scanIntervalMinutes ?? null,
        nfoEnabled: data.nfoEnabled ?? false,
        artworkEnabled: data.artworkEnabled ?? true,
      },
    });
  }

  update(id: string, data: LibraryInput) {
    // Validate the path against the hard roots whenever one is supplied.
    const safePath =
      data.path != null ? this.filePath.assertWithinHardRoots(data.path) : undefined;
    return this.prisma.mediaLibrary.update({
      where: { id },
      data: {
        name: data.name,
        path: safePath,
        kind: data.kind,
        preset: data.preset,
        template: data.template,
        mode: data.mode,
        isEnabled: data.isEnabled,
        scanIntervalMinutes: data.scanIntervalMinutes,
        nfoEnabled: data.nfoEnabled,
        artworkEnabled: data.artworkEnabled,
      },
    });
  }

  async remove(id: string) {
    const library = await this.prisma.mediaLibrary.delete({ where: { id } });
    // The library's items cascade away with it, so any duplicate group that spanned
    // this library and another is left holding one side of a comparison.
    await this.duplicates.pruneOrphanedGroups();
    return library;
  }
}
