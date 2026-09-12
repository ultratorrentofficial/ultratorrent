import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { MediaAnalyticsUser, MediaStreamPolicy } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import {
  ENFORCEMENT_ACTIONS,
  ENFORCEMENT_SCOPES,
  EnforcementAction,
  EnforcementScope,
  StreamControlSettings,
  StreamControlSettingsService,
} from './stream-control-settings.service';

/** Where the winning limit came from, for the "2 streams — inherited from …" hint. */
export type PolicySource = 'exempt' | 'user_server' | 'user' | 'server' | 'global';

/** A fully-resolved policy for one subject (and, under per-server scope, one server). */
export interface EffectivePolicy {
  /** null = unlimited. */
  limit: number | null;
  action: EnforcementAction;
  gracePeriodSeconds: number;
  countPaused: boolean;
  pausedExpirationMinutes: number;
  scope: EnforcementScope;
  source: PolicySource;
  exempt: boolean;
}

/** The editable shape of a per-user override (the Stream Limits editor). */
export interface StreamPolicyInput {
  /** null = unlimited; a positive integer is a custom cap; omit to clear the override. */
  maxConcurrentStreams?: number | null;
  mediaServerId?: string | null;
  enforcementAction?: EnforcementAction | null;
  gracePeriodSeconds?: number | null;
  countPaused?: boolean | null;
  scope?: EnforcementScope | null;
  enabled?: boolean;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(n)));

@Injectable()
export class StreamPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: StreamControlSettingsService,
  ) {}

  /**
   * Resolve — creating if new — the canonical subject for a live session.
   *
   * `kind` is the product (plex/jellyfin/emby); `providerUserId` is its stable id.
   * Plex ids are global to plex.tv, so the same account across several Plex servers
   * maps to ONE subject; Jellyfin/Emby ids are per-server, so they stay separate.
   * Returns null when there is no stable id to key on (an unresolved identity is
   * never enforced — spec §19).
   */
  async resolveSubject(kind: string, providerUserId: string | null | undefined, displayName?: string | null): Promise<MediaAnalyticsUser | null> {
    const pid = (providerUserId ?? '').trim();
    if (!pid || !['plex', 'jellyfin', 'emby'].includes(kind)) return null;
    const existing = await this.prisma.mediaAnalyticsUser.findUnique({ where: { kind_providerUserId: { kind, providerUserId: pid } } });
    if (existing) {
      // Keep the cached display name fresh, but never clobber a set name with null.
      if (displayName && displayName !== existing.displayName) {
        return this.prisma.mediaAnalyticsUser.update({ where: { id: existing.id }, data: { displayName } });
      }
      return existing;
    }
    return this.prisma.mediaAnalyticsUser.create({ data: { kind, providerUserId: pid, displayName: displayName ?? null } });
  }

  /** Resolve the effective policy for a subject, optionally scoped to one server. */
  effectivePolicy(user: MediaAnalyticsUser, policy: MediaStreamPolicy | null, serverDefault: MediaStreamPolicy | null, serverId: string | null, settings: StreamControlSettings): EffectivePolicy {
    const base = {
      action: settings.defaultAction,
      gracePeriodSeconds: settings.gracePeriodSeconds,
      countPaused: settings.countPaused,
      pausedExpirationMinutes: settings.pausedExpirationMinutes,
      scope: settings.scope,
    };
    if (user.exemptFromLimits) {
      return { ...base, limit: null, source: 'exempt', exempt: true };
    }
    // The user's single override applies when it is enabled and either global
    // (no server) or scoped to the server we are resolving for.
    const userRow = policy && policy.enabled && (policy.mediaServerId == null || policy.mediaServerId === serverId) ? policy : null;
    const serverRow = serverDefault && serverDefault.enabled ? serverDefault : null;
    const chosen = userRow ?? serverRow;
    if (chosen) {
      const source: PolicySource = userRow ? (userRow.mediaServerId ? 'user_server' : 'user') : 'server';
      return {
        limit: chosen.maxConcurrentStreams, // null = unlimited
        action: (chosen.enforcementAction as EnforcementAction) ?? base.action,
        gracePeriodSeconds: chosen.gracePeriodSeconds ?? base.gracePeriodSeconds,
        countPaused: chosen.countPaused ?? base.countPaused,
        pausedExpirationMinutes: base.pausedExpirationMinutes,
        scope: (chosen.scope as EnforcementScope) ?? base.scope,
        source,
        exempt: false,
      };
    }
    return { ...base, limit: settings.defaultLimit, source: 'global', exempt: false };
  }

  /** A subject's own override row (the one keyed by userId), if any. */
  policyForUser(userId: string): Promise<MediaStreamPolicy | null> {
    return this.prisma.mediaStreamPolicy.findUnique({ where: { mediaAnalyticsUserId: userId } });
  }

  /** All per-server default rows (userId null), keyed by server id. */
  async serverDefaults(): Promise<Map<string, MediaStreamPolicy>> {
    const rows = await this.prisma.mediaStreamPolicy.findMany({ where: { mediaAnalyticsUserId: null, mediaServerId: { not: null } } });
    return new Map(rows.map((r) => [r.mediaServerId as string, r]));
  }

  /** List every user override with its subject (for the Stream Limits admin list). */
  listUserPolicies() {
    return this.prisma.mediaStreamPolicy.findMany({ where: { mediaAnalyticsUserId: { not: null } }, include: { user: true } });
  }

  /** Every canonical subject with its override (the Stream Limits page roster). */
  listSubjects() {
    return this.prisma.mediaAnalyticsUser.findMany({ include: { policy: true }, orderBy: [{ displayName: 'asc' }, { providerUserId: 'asc' }] });
  }

  /**
   * Seed canonical subjects from the viewers analytics already knows, so an admin
   * can set a limit for anyone the server has seen — not only whoever happens to
   * be streaming while enforcement runs. Each `MediaServerUser` with a provider id
   * on a live connection maps to a subject by `(connection kind, providerUserId)`;
   * `resolveSubject` is idempotent, so this is safe to run on every roster read.
   */
  async syncSubjectsFromKnownUsers(): Promise<void> {
    const [users, conns] = await Promise.all([
      this.prisma.mediaServerUser.findMany({
        where: { providerUserId: { not: null }, connectionId: { not: null } },
        select: { connectionId: true, providerUserId: true, userName: true, displayName: true },
      }),
      this.prisma.mediaServerIntegration.findMany({ select: { id: true, kind: true } }),
    ]);
    if (users.length === 0) return;
    const kindByConn = new Map(conns.map((c) => [c.id, c.kind]));
    for (const u of users) {
      const kind = kindByConn.get(u.connectionId as string);
      if (kind) await this.resolveSubject(kind, u.providerUserId, u.displayName ?? u.userName);
    }
  }

  subject(userId: string) {
    return this.prisma.mediaAnalyticsUser.findUnique({ where: { id: userId }, include: { policy: true } });
  }

  /** Upsert a subject's per-user override. A null `maxConcurrentStreams` means
   * unlimited; the caller deletes the row to fall back to the global default. */
  async putUserPolicy(userId: string, input: StreamPolicyInput): Promise<MediaStreamPolicy> {
    const data = {
      maxConcurrentStreams:
        input.maxConcurrentStreams === null || input.maxConcurrentStreams === undefined
          ? null
          : clamp(input.maxConcurrentStreams, 1, 100),
      mediaServerId: input.mediaServerId ?? null,
      enforcementAction: input.enforcementAction && ENFORCEMENT_ACTIONS.includes(input.enforcementAction) ? input.enforcementAction : null,
      gracePeriodSeconds: input.gracePeriodSeconds == null ? null : clamp(input.gracePeriodSeconds, 0, 300),
      countPaused: typeof input.countPaused === 'boolean' ? input.countPaused : null,
      scope: input.scope && ENFORCEMENT_SCOPES.includes(input.scope) ? input.scope : null,
      enabled: input.enabled ?? true,
    };
    return this.prisma.mediaStreamPolicy.upsert({
      where: { mediaAnalyticsUserId: userId },
      create: { mediaAnalyticsUserId: userId, ...data },
      update: data,
    });
  }

  /** Remove a subject's override (back to the global/per-server default). */
  async deleteUserPolicy(userId: string): Promise<void> {
    await this.prisma.mediaStreamPolicy.deleteMany({ where: { mediaAnalyticsUserId: userId } });
  }

  /** Mark a subject exempt (or not) from all limits — the admin bypass (spec §20). */
  async setExempt(userId: string, exempt: boolean): Promise<MediaAnalyticsUser> {
    return this.prisma.mediaAnalyticsUser.update({ where: { id: userId }, data: { exemptFromLimits: exempt } });
  }

  /**
   * Link two or more canonical subjects as the SAME person, so their streams
   * count together (spec §6). Only ever an explicit admin action — accounts are
   * never joined by a matching name or email. Merges any groups the subjects are
   * already in into one.
   */
  async linkSubjects(ids: string[]): Promise<string | null> {
    const unique = [...new Set(ids)];
    if (unique.length < 2) return null;
    const subjects = await this.prisma.mediaAnalyticsUser.findMany({ where: { id: { in: unique } } });
    if (subjects.length < 2) return null;
    const existingGroupIds = [...new Set(subjects.map((s) => s.groupId).filter(Boolean))] as string[];
    const groupId = existingGroupIds[0] ?? randomUUID();
    await this.prisma.mediaAnalyticsUser.updateMany({
      where: { OR: [{ id: { in: unique } }, ...(existingGroupIds.length ? [{ groupId: { in: existingGroupIds } }] : [])] },
      data: { groupId },
    });
    return groupId;
  }

  /** Remove a subject from its link group. If that leaves a single member, the
   * group is dissolved (a group of one is meaningless). */
  async unlinkSubject(id: string): Promise<void> {
    const subject = await this.prisma.mediaAnalyticsUser.findUnique({ where: { id } });
    if (!subject?.groupId) return;
    const groupId = subject.groupId;
    await this.prisma.mediaAnalyticsUser.update({ where: { id }, data: { groupId: null } });
    const remaining = await this.prisma.mediaAnalyticsUser.findMany({ where: { groupId } });
    if (remaining.length <= 1) {
      await this.prisma.mediaAnalyticsUser.updateMany({ where: { groupId }, data: { groupId: null } });
    }
  }

  /**
   * Combine several members' resolved policies into ONE group policy: the most
   * restrictive wins. Any exempt member exempts the whole person; otherwise the
   * tightest numeric limit (and its action/grace/scope) applies, and an all-null
   * set stays unlimited.
   */
  combineEffective(effs: EffectivePolicy[]): EffectivePolicy {
    if (effs.length === 1) return effs[0];
    if (effs.some((e) => e.exempt)) return { ...effs[0], limit: null, exempt: true, source: 'exempt' };
    let chosen = effs[0];
    for (const e of effs) {
      if (e.limit != null && (chosen.limit == null || e.limit < chosen.limit)) chosen = e;
    }
    return chosen;
  }

  loadSettings(): Promise<StreamControlSettings> {
    return this.settings.read();
  }
}
