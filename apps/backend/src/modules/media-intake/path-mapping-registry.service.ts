import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { fromSpace, toSpace, PATH_SPACES, type PathMappingRule, type PathSpace } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/**
 * The one place that knows how a path is spelled outside this process.
 *
 * The same bytes are `/mnt/media/x` to the host, `/downloads/x` inside the
 * backend container, something else again to a torrent client in its own
 * container, and possibly a fourth thing to Plex. Every one of those has been a
 * real bug, and the failure mode is always the same: a path that looks correct,
 * points at nothing, and reports success.
 *
 * So modules never spell a foreign path themselves — they hold the canonical
 * one and ask this registry to render it into whichever space they are about to
 * hand it to.
 *
 * Rules are cached because translation happens on every stage of every intake
 * and the rule set changes about never; the cache is dropped on any write
 * rather than timed out, so a corrected mapping takes effect on the next call
 * instead of at the end of some interval.
 */
@Injectable()
export class PathMappingRegistryService {
  private readonly logger = new Logger(PathMappingRegistryService.name);
  private cache: PathMappingRule[] | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** Every enabled rule, cached. */
  async rules(): Promise<PathMappingRule[]> {
    if (this.cache) return this.cache;
    const rows = await this.prisma.pathMappingRule.findMany({
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
    this.cache = rows.map((r) => ({
      id: r.id,
      space: r.space as PathSpace,
      fromPrefix: r.fromPrefix,
      toPrefix: r.toPrefix,
      scopeId: r.scopeId,
      priority: r.priority,
      enabled: r.isEnabled,
    }));
    return this.cache;
  }

  /** Drop the cache. Called on every write; exposed for tests and for a reload. */
  invalidate(): void {
    this.cache = null;
  }

  /** Render a canonical path into the spelling `space` uses. */
  async toSpace(canonical: string, space: PathSpace, scopeId?: string | null): Promise<string> {
    return toSpace(canonical, space, await this.rules(), scopeId);
  }

  /** Take a path as `space` spells it and return the canonical form. */
  async fromSpace(path: string, space: PathSpace, scopeId?: string | null): Promise<string> {
    return fromSpace(path, space, await this.rules(), scopeId);
  }

  list() {
    return this.prisma.pathMappingRule.findMany({
      orderBy: [{ space: 'asc' }, { priority: 'desc' }],
    });
  }

  async create(input: {
    space: string; fromPrefix: string; toPrefix: string;
    scopeId?: string | null; priority?: number; isEnabled?: boolean;
  }) {
    this.assertValid(input);
    const row = await this.prisma.pathMappingRule.create({
      data: {
        space: input.space,
        fromPrefix: input.fromPrefix.trim(),
        toPrefix: input.toPrefix.trim(),
        scopeId: input.scopeId?.trim() || null,
        priority: input.priority ?? 0,
        isEnabled: input.isEnabled ?? true,
      },
    });
    this.invalidate();
    return row;
  }

  async update(id: string, input: Partial<{
    space: string; fromPrefix: string; toPrefix: string;
    scopeId: string | null; priority: number; isEnabled: boolean;
  }>) {
    // Validate the MERGED rule, not the patch: a request that only changes
    // `space` still has to produce a rule that makes sense as a whole.
    const current = await this.prisma.pathMappingRule.findUnique({ where: { id } });
    if (!current) throw new BadRequestException('Path mapping rule not found.');
    this.assertValid({ ...current, ...input } as never);
    const row = await this.prisma.pathMappingRule.update({ where: { id }, data: input });
    this.invalidate();
    return row;
  }

  async remove(id: string) {
    await this.prisma.pathMappingRule.delete({ where: { id } });
    this.invalidate();
    return { ok: true as const };
  }

  /**
   * Reject a rule that cannot mean anything useful.
   *
   * Relative prefixes are the important one: a mapping is a textual prefix
   * rewrite, and a relative prefix would match by accident somewhere in the
   * middle of a path and rewrite an import into an unrelated tree. An identity
   * rule is refused too — it is always a mistake, and a silently inert rule is
   * worse than an error, because the operator believes a mapping is in place.
   */
  private assertValid(input: { space: string; fromPrefix: string; toPrefix: string }): void {
    if (!PATH_SPACES.includes(input.space as PathSpace)) {
      throw new BadRequestException(`Unknown path space "${input.space}".`);
    }
    if (input.space === 'canonical') {
      throw new BadRequestException('The canonical space is the source; it cannot be a target.');
    }
    for (const [label, value] of [['fromPrefix', input.fromPrefix], ['toPrefix', input.toPrefix]] as const) {
      if (!value?.trim()) throw new BadRequestException(`${label} is required.`);
      if (!value.trim().startsWith('/')) {
        throw new BadRequestException(`${label} must be an absolute path.`);
      }
    }
    if (input.fromPrefix.trim() === input.toPrefix.trim()) {
      throw new BadRequestException('A mapping that changes nothing has no effect.');
    }
  }
}
