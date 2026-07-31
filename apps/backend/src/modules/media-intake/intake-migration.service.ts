import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { StorageProfileService, nests } from './storage-profile.service';

const MANAGED = 'managed_intake';
const LEGACY = 'legacy_direct';

/** Why a rule can or cannot be converted, decided before anything is written. */
export type MigrationVerdict =
  | 'convertible'
  | 'already_managed'
  | 'no_profile'
  | 'staging_conflict';

export interface RuleMigrationPreview {
  ruleId: string;
  name: string;
  currentSavePath: string | null;
  proposedSavePath: string | null;
  profileId: string | null;
  profileName: string | null;
  verdict: MigrationVerdict;
  reason: string | null;
}

/**
 * Bulk conversion of RSS rules to managed intake.
 *
 * Converting one rule is two coordinated edits — repoint `savePath` at staging,
 * then set `importMode` — and the rule service refuses the wrong order, because
 * a managed rule that still downloads into its destination library imports that
 * library into itself. Correct, but it makes converting by hand a two-step dance
 * per rule, and an install can carry hundreds. This does the pair atomically for
 * a chosen set.
 *
 * It never converts anything on its own: {@link preview} decides and explains,
 * {@link apply} acts only on ids the operator sent back. That split is the point
 * — the dangerous half of a migration is the one that guesses which rules were
 * meant.
 */
@Injectable()
export class IntakeMigrationService {
  private readonly logger = new Logger(IntakeMigrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: StorageProfileService,
  ) {}

  /**
   * What would happen to every rule, without touching anything.
   *
   * Every rule is listed, including the ones that cannot move — a preview that
   * hides its refusals leaves the operator wondering why a count does not match,
   * and "why is this one missing" is a worse question than "why is this one
   * blocked".
   */
  async preview(profileId?: string): Promise<RuleMigrationPreview[]> {
    const rules = await this.prisma.rssRule.findMany({
      select: { id: true, name: true, savePath: true, importMode: true, storageProfileId: true },
      orderBy: { name: 'asc' },
    });
    const fallback = await this.profiles.defaultProfile();
    const explicit = new Map<string, Awaited<ReturnType<StorageProfileService['get']>>>();

    const out: RuleMigrationPreview[] = [];
    for (const rule of rules) {
      const wantedProfileId = profileId ?? rule.storageProfileId ?? null;
      let profile = fallback as { id: string; name: string; stagingRoot: string;
        movieLibrary?: { name: string; path: string } | null;
        tvLibrary?: { name: string; path: string } | null;
        musicLibrary?: { name: string; path: string } | null } | null;
      if (wantedProfileId) {
        if (!explicit.has(wantedProfileId)) {
          explicit.set(wantedProfileId, await this.profiles.get(wantedProfileId).catch(() => null) as never);
        }
        profile = explicit.get(wantedProfileId) as never;
      }

      const base = {
        ruleId: rule.id,
        name: rule.name,
        currentSavePath: rule.savePath,
        profileId: profile?.id ?? null,
        profileName: profile?.name ?? null,
      };

      if (rule.importMode === MANAGED) {
        out.push({ ...base, proposedSavePath: null, verdict: 'already_managed', reason: null });
        continue;
      }
      if (!profile) {
        out.push({
          ...base, proposedSavePath: null, verdict: 'no_profile',
          reason: 'No storage profile resolves for this rule, so there is nowhere to stage.',
        });
        continue;
      }

      const proposed = this.stagingPathFor(profile.stagingRoot, rule.savePath, rule.name);
      // The profile's own staging root must not sit inside a destination library;
      // that is checked when the profile is saved, but a profile edited since
      // could have drifted, and converting into it would import a library into
      // itself for every rule at once.
      const conflict = [profile.movieLibrary, profile.tvLibrary, profile.musicLibrary]
        .filter((l): l is { name: string; path: string } => !!l?.path)
        .find((l) => nests(proposed, l.path));
      if (conflict) {
        out.push({
          ...base, proposedSavePath: proposed, verdict: 'staging_conflict',
          reason: `The staging path would sit inside the "${conflict.name}" library.`,
        });
        continue;
      }

      out.push({ ...base, proposedSavePath: proposed, verdict: 'convertible', reason: null });
    }
    return out;
  }

  /**
   * Convert the named rules, both fields together, in one transaction.
   *
   * Re-previews rather than trusting the ids: the operator's list was computed
   * against a snapshot, and a rule edited in between could have become
   * unconvertible. Writing a half-valid pair is exactly the corruption the rule
   * service refuses one at a time.
   */
  async apply(ruleIds: string[], userId?: string): Promise<{ converted: number; skipped: RuleMigrationPreview[] }> {
    if (!ruleIds?.length) throw new BadRequestException('No rules were selected.');
    const wanted = new Set(ruleIds);
    const fresh = (await this.preview()).filter((p) => wanted.has(p.ruleId));

    const ok = fresh.filter((p) => p.verdict === 'convertible' && p.proposedSavePath);
    const skipped = fresh.filter((p) => p.verdict !== 'convertible');

    if (ok.length) {
      await this.prisma.$transaction(
        ok.map((p) =>
          this.prisma.rssRule.update({
            where: { id: p.ruleId },
            data: {
              // Recorded BEFORE the overwrite; without it a revert cannot put the
              // rule back and would leave it downloading into staging forever.
              preMigrationSavePath: p.currentSavePath,
              savePath: p.proposedSavePath,
              importMode: MANAGED,
              storageProfileId: p.profileId,
            },
          }),
        ),
      );
      this.logger.log(
        `Migrated ${ok.length} rule(s) to managed intake${userId ? ` (by ${userId})` : ''}: `
          + ok.map((p) => p.name).join(', '),
      );
    }
    return { converted: ok.length, skipped };
  }

  /**
   * Put converted rules back exactly as they were.
   *
   * Restores the recorded save path as well as the mode. A revert that only
   * flipped `importMode` would leave the rule downloading into staging with
   * nothing importing from there — stranding every future episode, which is
   * worse than the state the operator was trying to escape.
   */
  async revert(ruleIds: string[], userId?: string): Promise<{ reverted: number; skipped: string[] }> {
    if (!ruleIds?.length) throw new BadRequestException('No rules were selected.');
    const rules = await this.prisma.rssRule.findMany({
      where: { id: { in: ruleIds } },
      select: { id: true, name: true, preMigrationSavePath: true, importMode: true },
    });

    // A rule the wizard never converted has no recorded path to restore, and
    // guessing one would point it somewhere it has never downloaded.
    const restorable = rules.filter((r) => r.preMigrationSavePath !== null);
    const skipped = rules.filter((r) => r.preMigrationSavePath === null).map((r) => r.name);

    if (restorable.length) {
      await this.prisma.$transaction(
        restorable.map((r) =>
          this.prisma.rssRule.update({
            where: { id: r.id },
            data: {
              savePath: r.preMigrationSavePath,
              importMode: LEGACY,
              preMigrationSavePath: null,
            },
          }),
        ),
      );
      this.logger.log(
        `Reverted ${restorable.length} rule(s) to legacy direct${userId ? ` (by ${userId})` : ''}.`,
      );
    }
    return { reverted: restorable.length, skipped };
  }

  /**
   * Where a rule should stage.
   *
   * Keeps the show's own folder name rather than flattening everything into the
   * staging root: intake keys a job by its source path, so two shows finishing at
   * once in one directory collide. The name comes from the rule's existing save
   * path when it has one — that is the folder the operator already chose for this
   * show — and falls back to the rule name.
   */
  private stagingPathFor(stagingRoot: string, savePath: string | null, ruleName: string): string {
    const root = stagingRoot.trim().replace(/\/+$/, '');
    const fromPath = savePath?.trim().replace(/\/+$/, '').split('/').filter(Boolean).pop();
    const leaf = (fromPath || ruleName).replace(/\//g, '-').trim();
    return `${root}/${leaf}`;
  }
}
