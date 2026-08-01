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
  autoOrganize?: boolean;
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

  /**
   * A library's mode is a filesystem VERB — never `preview`.
   *
   * `preview` remains valid for a one-off REQUEST ("plan this, touch nothing" —
   * the ad-hoc Dry Run tab and Media Intake's placement stage both rely on it),
   * but stored on a library it answered a second question nobody asked: `apply`
   * short-circuits on it, so an explicitly-confirmed manual rename became a
   * no-op that still reported success. `autoOrganize` carries the "may the
   * organiser act" question on its own now.
   */
  private static readonly LIBRARY_MODES = [
    'rename_in_place', 'rename_move', 'copy', 'hardlink', 'symlink',
  ];

  private assertMode(mode: unknown): void {
    if (mode === undefined || mode === null) return; // not being changed
    if (mode === 'preview') {
      throw new BadRequestException(
        'A library cannot be set to "preview". To stop the organiser touching it, '
          + 'turn off automatic organising and keep a real mode (e.g. "rename_in_place").',
      );
    }
    if (!MediaLibraryService.LIBRARY_MODES.includes(mode as string)) {
      throw new BadRequestException(
        `Unknown library mode "${String(mode)}". Expected one of: ${MediaLibraryService.LIBRARY_MODES.join(', ')}.`,
      );
    }
  }

  create(data: LibraryInput) {
    if (!data?.name || !data?.path) {
      throw new BadRequestException('name and path are required');
    }
    this.assertMode(data.mode);
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
        // Off by default: a library starts inert and is opted in deliberately.
        autoOrganize: data.autoOrganize ?? false,
        isEnabled: data.isEnabled ?? true,
        scanIntervalMinutes: data.scanIntervalMinutes ?? null,
        nfoEnabled: data.nfoEnabled ?? false,
        artworkEnabled: data.artworkEnabled ?? true,
      },
    });
  }

  update(id: string, data: LibraryInput) {
    this.assertMode(data.mode);
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
        autoOrganize: data.autoOrganize,
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
