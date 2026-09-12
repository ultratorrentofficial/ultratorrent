import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { MODULE_IDS } from '@ultratorrent/shared';
import type { MediaAnalyticsUser, MediaStreamPolicy } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { ModuleRegistryService } from '../../module-registry/module-registry.service';
import { MediaServerIntegrationService } from '../../media/media-server-integration.service';
import { DistributedLockService } from '../../redis/distributed-lock.service';
import { StreamPolicyService, EffectivePolicy } from './stream-policy.service';
import { StreamControlSettings } from './stream-control-settings.service';
import { limitReachedMessage } from './stream-messages';

/** A session row as the engine reads it (a subset of `MediaServerSession`). */
interface SessionRow {
  id: string;
  connectionId: string;
  providerSessionId: string;
  providerUserId: string | null;
  userName: string | null;
  title: string;
  device: string | null;
  client: string | null;
  ipAddress: string | null;
  playbackState: string | null;
  startedAt: Date;
  updatedAt: Date;
}

/** A live session enriched with its server kind, terminability, and canonical subject. */
type EnrichedSession = SessionRow & { kind: string; canTerminate: boolean; subject: MediaAnalyticsUser };

/** One counted group: a person (possibly several linked subjects), optionally
 * scoped to a server, with its combined policy. `subject` is a representative. */
interface Group {
  subject: MediaAnalyticsUser;
  kind: string;
  serverId: string | null;
  eff: EffectivePolicy;
  sessions: EnrichedSession[];
  counted: EnrichedSession[];
}

const INTERVAL_MS = 5_000;
const LOCK_TTL_MS = 15_000;
// A session the poller has not refreshed within this window is stale; it is not
// counted and never terminated (safety §19).
const STALE_MS = 90_000;

@Injectable()
export class StreamEnforcementService {
  private readonly logger = new Logger(StreamEnforcementService.name);
  private running = false;
  /** Per-group grace start (`subjectId:serverId` → first-over timestamp). */
  private readonly pending = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: StreamPolicyService,
    private readonly integrations: MediaServerIntegrationService,
    private readonly realtime: RealtimeGateway,
    private readonly registry: ModuleRegistryService,
    private readonly lock: DistributedLockService,
  ) {}

  private get moduleEnabled(): boolean {
    return this.registry.getStatus(MODULE_IDS.MEDIA_SERVER_ANALYTICS)?.enabled ?? false;
  }

  @Interval('media_server_stream_enforcement', INTERVAL_MS)
  async scheduledEnforce(): Promise<void> {
    if (!this.moduleEnabled || this.running) return;
    this.running = true;
    try {
      await this.enforce();
    } catch (err) {
      this.logger.warn(`Stream enforcement failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** One enforcement pass over the current session snapshot. */
  async enforce(): Promise<void> {
    const settings = await this.policy.loadSettings();
    if (!settings.enabled) {
      this.pending.clear();
      return;
    }
    const now = Date.now();
    const groups = await this.computeGroups(now, settings, true);
    const seen = new Set<string>();

    for (const g of groups) {
      // Only groups with an actual numeric limit can be over it.
      if (g.eff.exempt || g.eff.limit == null) continue;
      const key = `${g.subject.id}:${g.serverId ?? 'all'}`;
      const overBy = g.counted.length - g.eff.limit;
      if (overBy <= 0) {
        this.pending.delete(key);
        continue;
      }
      seen.add(key);
      await this.handleOverLimit(key, g, settings, now);
    }
    // Drop grace state for groups that are no longer over the limit.
    for (const key of [...this.pending.keys()]) if (!seen.has(key)) this.pending.delete(key);
  }

  private async handleOverLimit(key: string, g: Group, settings: StreamControlSettings, now: number): Promise<void> {
    const limit = g.eff.limit as number;

    // Warn/log actions never terminate — record the observation and (for warn)
    // tell the operator, then leave the streams alone.
    if (g.eff.action === 'warn' || g.eff.action === 'log') {
      await this.record(g, limit, g.counted.length, g.eff.action, 'skipped', 'soft action — not terminated');
      if (g.eff.action === 'warn') this.emitExceeded(g, limit);
      return;
    }

    // Grace: give a client mid-handoff time to settle before we act. A zero grace
    // acts on the first detection; a positive grace waits at least that long.
    const startedAt = this.pending.get(key);
    if (startedAt === undefined) {
      this.pending.set(key, now);
      this.emitExceeded(g, limit);
      if (g.eff.gracePeriodSeconds > 0) return;
    } else if (now - startedAt < g.eff.gracePeriodSeconds * 1000) {
      return;
    }

    // Grace elapsed — acquire an exclusive lock so no other replica double-acts.
    await this.lock.withLock(`media-stream-enforcement:${g.subject.id}`, LOCK_TTL_MS, async () => {
      // Re-derive under the lock from fresh state (idempotency §12): the account
      // may already be back in compliance, or a session may have ended.
      const fresh = await this.computeGroups(Date.now(), settings, false);
      const current = fresh.find((x) => `${x.subject.id}:${x.serverId ?? 'all'}` === key);
      if (!current || current.eff.limit == null || current.eff.exempt) {
        this.pending.delete(key);
        return;
      }
      const stillOver = current.counted.length - (current.eff.limit as number);
      if (stillOver <= 0) {
        this.pending.delete(key);
        return;
      }
      const victims = this.selectVictims(current.counted, current.eff.limit as number, current.eff.action);
      for (const v of victims) {
        await this.terminate(current, v, current.eff.limit as number, current.counted.length);
      }
      this.pending.delete(key);
    });
  }

  /** Choose exactly the excess sessions to stop, oldest preserved (newest) or vice versa. */
  private selectVictims(counted: Group['counted'], limit: number, action: string): Group['counted'] {
    const overBy = counted.length - limit;
    if (overBy <= 0) return [];
    const byStart = [...counted].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    // terminate_newest: keep the oldest `limit`, stop the newest excess.
    return action === 'terminate_oldest' ? byStart.slice(0, overBy) : byStart.slice(byStart.length - overBy);
  }

  private async terminate(g: Group, victim: Group['counted'][number], limit: number, observed: number): Promise<void> {
    this.realtime.broadcast('media_server.stream.termination_requested', {
      connectionId: victim.connectionId, sessionId: victim.id, title: victim.title, userName: victim.userName,
    });
    let result = 'failure';
    let errorMessage: string | undefined;
    try {
      const outcome = await this.integrations.terminateSession(victim.connectionId, victim.providerSessionId, {
        message: limitReachedMessage(limit),
      });
      if (!outcome.supported) {
        result = 'skipped';
        errorMessage = outcome.message;
      } else if (outcome.result?.success) {
        result = 'success';
      } else {
        errorMessage = outcome.result?.message;
      }
    } catch (err) {
      errorMessage = (err as Error).message;
    }
    await this.record(g, limit, observed, g.eff.action, result, undefined, victim, errorMessage);
    this.realtime.broadcast(
      result === 'success' ? 'media_server.stream.terminated' : 'media_server.stream.termination_failed',
      { connectionId: victim.connectionId, sessionId: victim.id, title: victim.title, userName: victim.userName },
    );
  }

  private emitExceeded(g: Group, limit: number): void {
    this.realtime.broadcast('media_server.stream_limit.exceeded', {
      mediaAnalyticsUserId: g.subject.id,
      displayName: g.subject.displayName,
      activeStreams: g.counted.length,
      limit,
      serverId: g.serverId,
    });
  }

  private async record(
    g: Group,
    limit: number,
    observed: number,
    action: string,
    result: string,
    reason?: string,
    victim?: Group['counted'][number],
    errorMessage?: string,
  ): Promise<void> {
    // Attribute to the victim's own subject where there is one (a linked group can
    // span products, so the group's representative may be a different account).
    const attrib = victim?.subject ?? g.subject;
    await this.prisma.mediaStreamEnforcementEvent.create({
      data: {
        mediaAnalyticsUserId: attrib.id,
        mediaServerId: victim?.connectionId ?? g.serverId ?? g.sessions[0]?.connectionId ?? 'unknown',
        provider: victim?.kind ?? g.kind,
        providerUserId: attrib.providerUserId,
        providerSessionId: victim?.providerSessionId ?? '',
        mediaTitle: victim?.title ?? null,
        client: victim?.client ?? null,
        device: victim?.device ?? null,
        ipAddress: victim?.ipAddress ?? null,
        configuredLimit: limit,
        observedStreams: observed,
        action,
        result,
        reason: reason ?? null,
        errorMessage: errorMessage ?? null,
        enforcedAt: result === 'success' ? new Date() : null,
      },
    });
  }

  /**
   * Build the counted groups from the current session snapshot. `create` provisions
   * missing canonical subjects (enforcement pass) vs read-only (status pass).
   */
  async computeGroups(now: number, settings: StreamControlSettings, create: boolean): Promise<Group[]> {
    const sessions = (await this.prisma.mediaServerSession.findMany({
      select: {
        id: true, connectionId: true, providerSessionId: true, providerUserId: true, userName: true,
        title: true, device: true, client: true, ipAddress: true, playbackState: true, startedAt: true, updatedAt: true,
      },
    })) as SessionRow[];
    if (sessions.length === 0) return [];

    const conns = await this.prisma.mediaServerIntegration.findMany({ select: { id: true, kind: true, status: true, capabilities: true } });
    const connById = new Map(conns.map((c) => [c.id, c]));

    // Resolve each session to (kind, providerUserId) → canonical subject.
    // Group by the "count key": a subject's link-group if it has one, else the
    // subject itself, so linked accounts (a Plex + a Jellyfin) count together.
    const byKey = new Map<string, EnrichedSession[]>();
    const membersByKey = new Map<string, Map<string, MediaAnalyticsUser>>();
    const subjectOf = new Map<string, MediaAnalyticsUser>();
    for (const s of sessions) {
      const conn = connById.get(s.connectionId);
      if (!conn) continue; // unknown/removed server → never enforce
      // Uncertain server health: skip so we never act on a possibly-stale read.
      if (conn.status && conn.status !== 'online') continue;
      const key = `${conn.kind} ${s.providerUserId ?? ''}`;
      let subject = subjectOf.get(key);
      if (!subject) {
        const resolved = create
          ? await this.policy.resolveSubject(conn.kind, s.providerUserId, s.userName)
          : await this.prisma.mediaAnalyticsUser.findUnique({ where: { kind_providerUserId: { kind: conn.kind, providerUserId: (s.providerUserId ?? '').trim() } } }).catch(() => null);
        if (!resolved) continue; // unresolved identity → never enforce
        subject = resolved;
        subjectOf.set(key, subject);
      }
      const declared = (conn.capabilities as { terminateSessions?: boolean } | null)?.terminateSessions;
      const enriched: EnrichedSession = { ...s, kind: conn.kind, canTerminate: typeof declared === 'boolean' ? declared : conn.kind !== 'kodi', subject };
      const countKey = subject.groupId ?? subject.id;
      (byKey.get(countKey) ?? byKey.set(countKey, []).get(countKey)!).push(enriched);
      const members = membersByKey.get(countKey) ?? membersByKey.set(countKey, new Map()).get(countKey)!;
      members.set(subject.id, subject);
    }

    const allSubjectIds = [...new Set([...membersByKey.values()].flatMap((m) => [...m.keys()]))];
    if (allSubjectIds.length === 0) return [];
    const [userPolicies, serverDefaults] = await Promise.all([
      this.prisma.mediaStreamPolicy.findMany({ where: { mediaAnalyticsUserId: { in: allSubjectIds } } }),
      this.policy.serverDefaults(),
    ]);
    const policyByUser = new Map(userPolicies.map((p) => [p.mediaAnalyticsUserId as string, p]));

    // One member's effective policy at a given server scope.
    const memberEff = (m: MediaAnalyticsUser, serverId: string | null): EffectivePolicy =>
      this.policy.effectivePolicy(m, policyByUser.get(m.id) ?? null, serverId ? (serverDefaults.get(serverId) ?? null) : null, serverId, settings);

    const groups: Group[] = [];
    for (const [countKey, groupSessions] of byKey) {
      const members = [...(membersByKey.get(countKey)?.values() ?? [])];
      // The group's combined (all-servers) policy decides how its streams bucket.
      const combinedAll = this.policy.combineEffective(members.map((m) => memberEff(m, null)));
      const buckets: Array<{ serverId: string | null; rows: EnrichedSession[] }> =
        combinedAll.scope === 'per_server'
          ? [...groupBy(groupSessions, (r) => r.connectionId).entries()].map(([serverId, rows]) => ({ serverId, rows }))
          : [{ serverId: null, rows: groupSessions }];

      for (const b of buckets) {
        const eff = b.serverId === null ? combinedAll : this.policy.combineEffective(members.map((m) => memberEff(m, b.serverId)));
        const counted = b.rows.filter((r) => this.isCountable(r, eff, now));
        groups.push({ subject: members[0], kind: b.rows[0].kind, serverId: b.serverId, eff, sessions: b.rows, counted });
      }
    }
    return groups;
  }

  private isCountable(row: SessionRow, eff: EffectivePolicy, now: number): boolean {
    if (now - row.updatedAt.getTime() > STALE_MS) return false;
    if ((row.playbackState ?? '').toLowerCase() === 'paused') {
      if (!eff.countPaused) return false;
      if (eff.pausedExpirationMinutes > 0 && now - row.updatedAt.getTime() > eff.pausedExpirationMinutes * 60_000) return false;
    }
    return true;
  }

  /** Normalized enforcement state — the `GET /stream-control/status` payload and
   * the source of the Live Activity stream-count badge (keyed by session id). */
  async status(): Promise<{
    enabled: boolean;
    usesRedis: boolean;
    subjects: Array<{ mediaAnalyticsUserId: string; displayName: string | null; kind: string; activeStreams: number; limit: number | null; overLimit: boolean; exempt: boolean; scope: string; source: string }>;
    sessions: Record<string, { activeStreams: number; limit: number | null; overLimit: boolean; exempt: boolean; canEnforce: boolean }>;
  }> {
    const settings = await this.policy.loadSettings();
    const groups = settings.enabled ? await this.computeGroups(Date.now(), settings, false) : [];
    const subjects: Array<{ mediaAnalyticsUserId: string; displayName: string | null; kind: string; activeStreams: number; limit: number | null; overLimit: boolean; exempt: boolean; scope: string; source: string }> = [];
    const sessionMap: Record<string, { activeStreams: number; limit: number | null; overLimit: boolean; exempt: boolean; canEnforce: boolean }> = {};

    for (const g of groups) {
      const count = g.counted.length;
      const overLimit = g.eff.limit != null && count > g.eff.limit;
      subjects.push({
        mediaAnalyticsUserId: g.subject.id, displayName: g.subject.displayName, kind: g.kind,
        activeStreams: count, limit: g.eff.exempt ? null : g.eff.limit, overLimit, exempt: g.eff.exempt,
        scope: g.eff.scope, source: g.eff.source,
      });
      for (const s of g.sessions) {
        sessionMap[s.id] = {
          activeStreams: count,
          limit: g.eff.exempt ? null : g.eff.limit,
          overLimit,
          exempt: g.eff.exempt,
          canEnforce: s.canTerminate,
        };
      }
    }
    return { enabled: settings.enabled, usesRedis: this.lock.usesRedis(), subjects, sessions: sessionMap };
  }
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k) ?? [];
    arr.push(it);
    m.set(k, arr);
  }
  return m;
}
