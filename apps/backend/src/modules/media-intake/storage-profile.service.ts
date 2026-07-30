import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { IMPORT_STRATEGIES, type ImportStrategy } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface StorageProfileInput {
  name?: string;
  description?: string | null;
  isDefault?: boolean;
  isEnabled?: boolean;
  stagingRoot?: string;
  tempRoot?: string | null;
  failedRoot?: string | null;
  quarantineRoot?: string | null;
  movieLibraryId?: string | null;
  tvLibraryId?: string | null;
  musicLibraryId?: string | null;
  defaultStrategy?: string;
}

/**
 * Named sets of logical locations.
 *
 * A profile owns the roots intake itself needs — staging, temp, failed,
 * quarantine — and **references** existing libraries for the destinations
 * rather than restating their paths. A library already knows where it lives,
 * how it names files and which mode it uses; a second row holding a copy of
 * that path is a second thing to keep in sync, and the day they disagree the
 * import goes somewhere nobody expects.
 */
@Injectable()
export class StorageProfileService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.storageProfile.findMany({
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      include: { movieLibrary: true, tvLibrary: true, musicLibrary: true },
    });
  }

  async get(id: string) {
    const row = await this.prisma.storageProfile.findUnique({
      where: { id },
      include: { movieLibrary: true, tvLibrary: true, musicLibrary: true, capabilities: true },
    });
    if (!row) throw new NotFoundException('Storage profile not found');
    return row;
  }

  /** The profile a managed intake uses when a rule names none. */
  async defaultProfile() {
    return this.prisma.storageProfile.findFirst({
      where: { isDefault: true, isEnabled: true },
      include: { movieLibrary: true, tvLibrary: true, musicLibrary: true },
    });
  }

  async create(input: StorageProfileInput) {
    this.assertValid(input, true);
    await this.assertStagingIsolated(input);
    return this.prisma.$transaction(async (tx) => {
      // Exactly one default, enforced here rather than by a partial unique index
      // so the demotion and the promotion land in the same transaction — an
      // install with two defaults picks one arbitrarily and imports diverge.
      if (input.isDefault) {
        await tx.storageProfile.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      }
      return tx.storageProfile.create({
        data: {
          name: input.name!.trim(),
          description: input.description ?? null,
          isDefault: input.isDefault ?? false,
          isEnabled: input.isEnabled ?? true,
          stagingRoot: input.stagingRoot!.trim(),
          tempRoot: input.tempRoot?.trim() || null,
          failedRoot: input.failedRoot?.trim() || null,
          quarantineRoot: input.quarantineRoot?.trim() || null,
          movieLibraryId: input.movieLibraryId ?? null,
          tvLibraryId: input.tvLibraryId ?? null,
          musicLibraryId: input.musicLibraryId ?? null,
          defaultStrategy: input.defaultStrategy ?? 'auto',
        },
      });
    });
  }

  async update(id: string, input: StorageProfileInput) {
    const current = await this.get(id);
    this.assertValid({ ...current, ...input } as StorageProfileInput, false);
    await this.assertStagingIsolated({ ...current, ...input } as StorageProfileInput, current);
    return this.prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.storageProfile.updateMany({
          where: { isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }
      return tx.storageProfile.update({ where: { id }, data: input as never });
    });
  }

  /**
   * Delete a profile, unless rules still point at it.
   *
   * The foreign key is `SetNull`, so deleting would silently leave managed
   * rules with no profile — they would fall back to a default that may name
   * entirely different libraries. Refusing and naming the rules is the honest
   * outcome.
   */
  async remove(id: string) {
    const inUse = await this.prisma.rssRule.count({ where: { storageProfileId: id } });
    if (inUse > 0) {
      throw new BadRequestException(
        `${inUse} RSS rule(s) still use this profile. Point them elsewhere first.`,
      );
    }
    await this.prisma.storageProfile.delete({ where: { id } });
    return { ok: true as const };
  }

  private assertValid(input: StorageProfileInput, creating: boolean): void {
    if (creating || input.name !== undefined) {
      if (!input.name?.trim()) throw new BadRequestException('A profile name is required.');
    }
    if (creating || input.stagingRoot !== undefined) {
      if (!input.stagingRoot?.trim()) throw new BadRequestException('A staging root is required.');
      if (!input.stagingRoot.trim().startsWith('/')) {
        throw new BadRequestException('The staging root must be an absolute path.');
      }
    }
    for (const key of ['tempRoot', 'failedRoot', 'quarantineRoot'] as const) {
      const v = input[key];
      if (v && !v.trim().startsWith('/')) {
        throw new BadRequestException(`${key} must be an absolute path.`);
      }
    }
    if (input.defaultStrategy && !IMPORT_STRATEGIES.includes(input.defaultStrategy as ImportStrategy)) {
      throw new BadRequestException(`Unknown import strategy "${input.defaultStrategy}".`);
    }
  }

  /**
   * Staging must not sit inside a destination library, nor contain one.
   *
   * A scanner pointed at a library that contains staging will index
   * half-written files — and a partially copied episode that gets matched,
   * renamed and added to a collection is very hard to unpick afterwards. The
   * reverse nesting is just as bad: importing into a directory that is itself
   * being staged from means the source and destination are the same tree.
   *
   * Compared segment-wise for the usual reason: `/media/staging-old` is not
   * inside `/media/staging`.
   */
  private async assertStagingIsolated(input: StorageProfileInput, current?: { stagingRoot: string }): Promise<void> {
    const staging = (input.stagingRoot ?? current?.stagingRoot)?.trim();
    if (!staging) return;
    const ids = [input.movieLibraryId, input.tvLibraryId, input.musicLibraryId].filter(
      (v): v is string => !!v,
    );
    if (!ids.length) return;
    const libraries = await this.prisma.mediaLibrary.findMany({
      where: { id: { in: ids } },
      select: { name: true, path: true },
    });
    for (const lib of libraries) {
      if (nests(staging, lib.path) || nests(lib.path, staging)) {
        throw new BadRequestException(
          `The staging root and the "${lib.name}" library must not contain each other `
            + `(staging "${staging}", library "${lib.path}"). A scanner would index half-written files.`,
        );
      }
    }
  }
}

/** True when `a` is `b` or sits beneath it, compared segment-wise. */
function nests(a: string, b: string): boolean {
  const norm = (p: string) => {
    const c = p.replace(/\/+/g, '/');
    return c.length > 1 ? c.replace(/\/$/, '') : c;
  };
  const x = norm(a);
  const y = norm(b);
  return x === y || x.startsWith(y === '/' ? '/' : `${y}/`);
}
