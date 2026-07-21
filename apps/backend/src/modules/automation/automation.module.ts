import {
  Body,
  Controller,
  Delete,
  forwardRef,
  Get,
  Global,
  Injectable,
  Logger,
  Module,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
} from 'class-validator';
import type { Request } from 'express';
import { NormalizedTorrent, PERMISSIONS, NOTIFICATION_BUS_CHANNEL, type DomainEventEnvelope } from '@ultratorrent/shared';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { paginate, parsePage } from '../../common/pagination';
import { assertSafeOutboundUrl } from '../../common/ssrf';
import { EngineRegistryService } from '../engine/engine-registry.service';
import { AuditService } from '../audit/audit.service';
import { ModuleRef } from '@nestjs/core';
import { NotificationsService } from '../notifications/notifications.module';
import { NotificationCenterService } from '../notification-center/notification-center.service';
import { MediaService } from '../media/media.service';
import { MediaAutomationActions } from '../media/media-automation.actions';
import { SubtitleAutomationActions } from '../subtitle-intelligence/automation/subtitle-automation.actions';
import { RssModule } from '../rss/rss.module';
import {
  RssAutomationActions,
  RSS_ACTION_TYPES,
} from '../rss/tv-show-status/rss-automation.actions';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';

type Condition = { field: keyof NormalizedTorrent; op: string; value: unknown };
type Action = { type: string; params?: Record<string, unknown> };
/** Minimal rule shape the run-logging + audit-mirroring needs. */
type AutomationRuleRef = { id: string; name: string; actions: unknown };

/**
 * Catalog of automation triggers the engine understands. Triggers are matched by
 * string id when a rule is evaluated; this catalog is the metadata the UI needs
 * to present them (and the single place new triggers are registered).
 */
export const AUTOMATION_TRIGGERS = [
  { id: 'torrent.completed', label: 'When a download completes', category: 'torrent' },
  { id: 'ratio.reached', label: 'When the share ratio is reached', category: 'torrent' },
  { id: 'media.detected', label: 'When media is detected in a download', category: 'media' },
  { id: 'media.matched', label: 'When a media item is matched', category: 'media' },
  { id: 'media.unmatched', label: 'When a media item cannot be matched', category: 'media' },
  { id: 'media.missing_artwork', label: 'When a media item is missing artwork', category: 'media' },
  { id: 'media.missing_subtitles', label: 'When a media item is missing subtitles', category: 'media' },
  { id: 'media.rename_completed', label: 'When a media rename/move completes', category: 'media' },
  { id: 'media.server_refresh_failed', label: 'When a media-server refresh fails', category: 'media' },
  // Duplicate Center. There is deliberately NO "exact duplicate detected" trigger:
  // exact-match detection needs content hashing, which does not exist, and a rule
  // that can never fire is worse than an absent one — the Notification Center
  // already carried one such dead rule for months.
  { id: 'media.duplicate_scan_completed', label: 'When a duplicate scan completes', category: 'media' },
  { id: 'media.duplicate_detected', label: 'When a high-confidence duplicate is detected', category: 'media' },
  { id: 'media.duplicate_requires_review', label: 'When a duplicate needs manual review', category: 'media' },
  { id: 'media.duplicate_savings_threshold', label: 'When reclaimable space passes a threshold', category: 'media' },
  { id: 'media.duplicate_cleanup_completed', label: 'When a duplicate cleanup completes', category: 'media' },
  { id: 'media.duplicate_cleanup_failed', label: 'When a duplicate cleanup fails or partly fails', category: 'media' },
  { id: 'rss.rule.created_for_inactive_show', label: 'When an RSS rule is created for an inactive show', category: 'rss' },
  { id: 'rss.show_status.changed', label: "When a monitored show's airing status changes", category: 'rss' },
  { id: 'rss.show.became_active', label: 'When a monitored show becomes active again', category: 'rss' },
  { id: 'rss.show.ended', label: 'When a monitored show ends', category: 'rss' },
  { id: 'rss.show.canceled', label: 'When a monitored show is canceled', category: 'rss' },
  { id: 'subtitle.missing', label: 'When a media item is missing subtitles', category: 'subtitle' },
  { id: 'subtitle.downloaded', label: 'When a subtitle is downloaded', category: 'subtitle' },
  { id: 'subtitle.synchronized', label: 'When a subtitle is synchronized', category: 'subtitle' },
  { id: 'subtitle.validation_failed', label: 'When a subtitle fails validation', category: 'subtitle' },
  // Unified Jobs Center — operational job lifecycle triggers.
  { id: 'job.failed', label: 'When a job fails', category: 'jobs' },
  { id: 'job.stalled', label: 'When a job stalls', category: 'jobs' },
  { id: 'job.completed_with_warnings', label: 'When a job completes with warnings', category: 'jobs' },
  { id: 'job.retry_exhausted', label: 'When a job exhausts its retries', category: 'jobs' },
] as const;

/** Catalog of actions the engine can execute (metadata for the UI). */
export const AUTOMATION_ACTIONS = [
  { id: 'notify', label: 'Send notification', category: 'torrent' },
  { id: 'send_notification', label: 'Send via Notification Center', category: 'notification' },
  { id: 'move', label: 'Move data', category: 'torrent' },
  { id: 'pause', label: 'Pause torrent', category: 'torrent' },
  { id: 'stop', label: 'Stop torrent', category: 'torrent' },
  { id: 'delete', label: 'Remove torrent', category: 'torrent' },
  { id: 'delete_with_data', label: 'Remove torrent + data', category: 'torrent' },
  { id: 'webhook', label: 'Call webhook', category: 'torrent' },
  { id: 'rename_for_media', label: 'Rename for media server', category: 'media' },
  { id: 'media_scan_library', label: 'Scan a media library', category: 'media' },
  { id: 'media_match', label: 'Identify a media item', category: 'media' },
  { id: 'media_fetch_metadata', label: 'Fetch media metadata', category: 'media' },
  { id: 'media_fetch_artwork', label: 'Fetch media artwork', category: 'media' },
  { id: 'media_generate_nfo', label: 'Generate NFO sidecars', category: 'media' },
  { id: 'media_rename', label: 'Rename media into the library', category: 'media' },
  { id: 'media_move', label: 'Move media into the library', category: 'media' },
  { id: 'media_notify', label: 'Send media notification', category: 'media' },
  { id: 'media_server_refresh', label: 'Refresh a media server', category: 'media' },
  // Duplicate Center actions are non-destructive by design. There is no
  // "resolve duplicates" action: the brief requires that an automated destructive
  // cleanup be explicitly opted into behind a dedicated elevated permission, a
  // persisted preview, a per-run file/byte cap and a strict confidence policy —
  // none of which exists yet, and shipping the action first is how it gets used
  // before the guardrails arrive.
  { id: 'media_run_duplicate_scan', label: 'Run a duplicate scan', category: 'media' },
  { id: 'media_ignore_duplicate_group', label: 'Ignore a duplicate group', category: 'media' },
  { id: 'media_duplicate_report', label: 'Generate a duplicate report', category: 'media' },
  { id: 'refresh_rss_show_status', label: 'Refresh RSS show status', category: 'rss' },
  { id: 'disable_rss_rule', label: 'Disable RSS rule', category: 'rss' },
  { id: 'convert_rule_to_backfill', label: 'Convert rule to backfill only', category: 'rss' },
  { id: 'notify_admin', label: 'Notify admin', category: 'rss' },
  { id: 'subtitle_scan_missing', label: 'Scan a library for missing subtitles', category: 'subtitle' },
  { id: 'subtitle_download', label: 'Download subtitles for an item', category: 'subtitle' },
] as const;

/** Subtitle action ids delegated to SubtitleAutomationActions. */
const SUBTITLE_ACTION_TYPES = new Set(['subtitle_scan_missing', 'subtitle_download']);

/** Media action ids delegated to MediaAutomationActions. */
const MEDIA_ACTION_TYPES = new Set([
  'media_scan_library',
  'media_match',
  'media_fetch_metadata',
  'media_fetch_artwork',
  'media_generate_nfo',
  'media_rename',
  'media_move',
  'media_server_refresh',
  'media_run_duplicate_scan',
  'media_ignore_duplicate_group',
  'media_duplicate_report',
]);

class UpsertRuleDto {
  @IsString() name!: string;
  @IsOptional() @IsString() description?: string;
  @IsString() trigger!: string; // e.g. torrent.completed
  // Validated as arrays here, but the actual JSON contents are taken from the
  // raw request body in the controller — the global ValidationPipe's transform
  // would otherwise mangle these untyped nested objects.
  @IsArray() conditions!: Condition[];
  @IsArray() actions!: Action[];
  @IsOptional() @IsBoolean() isEnabled?: boolean;
  @IsOptional() @IsInt() priority?: number;
}

/** Pull the untouched conditions/actions JSON straight from the request body. */
function rawJson(req: Request): { conditions: Condition[]; actions: Action[] } {
  const body = (req.body ?? {}) as { conditions?: Condition[]; actions?: Action[] };
  return {
    conditions: Array.isArray(body.conditions) ? body.conditions : [],
    actions: Array.isArray(body.actions) ? body.actions : [],
  };
}

@Injectable()
export class AutomationEngine {
  private readonly logger = new Logger(AutomationEngine.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: EngineRegistryService,
    private readonly notifications: NotificationsService,
    private readonly media: MediaService,
    private readonly mediaActions: MediaAutomationActions,
    private readonly rssActions: RssAutomationActions,
    private readonly subtitleActions: SubtitleAutomationActions,
    private readonly audit: AuditService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Evaluate every enabled rule for a trigger against a single torrent. */
  async evaluate(
    trigger: string,
    context: NormalizedTorrent,
    previous?: NormalizedTorrent,
  ): Promise<void> {
    await this.applyRules(await this.loadRules(trigger), context, previous);
  }

  /**
   * Batch variant for periodic (poll-driven) triggers such as `ratio.reached`:
   * loads the rule set ONCE, then evaluates every torrent against it. Returns
   * immediately when no rule uses the trigger, so the common "no ratio rules"
   * case costs one cheap query per sync cycle rather than one per torrent.
   */
  async evaluateMany(
    trigger: string,
    items: Array<{ context: NormalizedTorrent; previous?: NormalizedTorrent }>,
  ): Promise<void> {
    const rules = await this.loadRules(trigger);
    if (rules.length === 0) return;
    for (const { context, previous } of items) {
      await this.applyRules(rules, context, previous);
    }
  }

  /**
   * Backfill pass for the `torrent.completed` trigger.
   *
   * The edge-fired path (TorrentSyncService.detectTransitions) only fires the
   * trigger on the exact poll where a torrent's persisted progress crosses to
   * 100%. Torrents that were ALREADY complete when first snapshotted, that
   * completed while the app wasn't polling, or that finished before the rule
   * existed never cross that edge — so their completion rules would never run
   * and the torrent sits there seeding forever.
   *
   * This re-evaluates already-complete torrents against every enabled
   * `torrent.completed` rule. AutomationLog is used as an idempotency ledger —
   * shared with the edge-fired path, which logs the same `{ hash }` context on
   * success — so each rule runs at most once per torrent no matter how often
   * the poll loop calls this. A failed run is NOT recorded as done, so a rule
   * blocked by a transient error (engine offline) retries on the next cycle.
   */
  async reconcileCompleted(torrents: NormalizedTorrent[]): Promise<void> {
    const completed = torrents.filter((t) => t.progress >= 1);
    if (completed.length === 0) return;

    const rules = await this.loadRules('torrent.completed');
    if (rules.length === 0) return;

    const done = await this.loadCompletedLedger(
      rules.map((r) => r.id),
      completed.map((t) => t.hash),
    );

    for (const t of completed) {
      for (const rule of rules) {
        const key = `${rule.id}::${t.hash}`;
        if (done.has(key)) continue;

        const conditions = (rule.conditions as unknown as Condition[]) ?? [];
        if (!conditions.every((c) => this.checkCondition(c, t))) continue;

        try {
          for (const action of (rule.actions as unknown as Action[]) ?? []) {
            await this.runAction(action, t);
          }
          await this.log(rule, 'success', t, null);
          done.add(key); // don't re-run this rule for the same torrent this pass
        } catch (err) {
          await this.log(rule, 'failed', t, (err as Error).message);
          await this.notifications.dispatch({
            level: 'error',
            title: 'Automation failed',
            message: `Rule "${rule.name}" failed: ${(err as Error).message}`,
            eventType: 'automation.failed',
          });
        }
      }
    }
  }

  /**
   * Build the "already ran" set (`ruleId::hash`) from successful AutomationLog
   * rows for the given rules and torrent hashes. Bounded by the current
   * completed-torrent set, so the OR list stays small.
   */
  private async loadCompletedLedger(
    ruleIds: string[],
    hashes: string[],
  ): Promise<Set<string>> {
    const logs = await this.prisma.automationLog.findMany({
      where: {
        status: 'success',
        ruleId: { in: ruleIds },
        OR: hashes.map((h) => ({ context: { path: ['hash'], equals: h } })),
      },
      select: { ruleId: true, context: true },
    });
    const done = new Set<string>();
    for (const l of logs) {
      const hash = (l.context as { hash?: string } | null)?.hash;
      if (hash) done.add(`${l.ruleId}::${hash}`);
    }
    return done;
  }

  /**
   * Evaluate rules for a NON-torrent trigger against a plain event context
   * (e.g. RSS show-status changes). Conditions match against the context object's
   * fields; only event-safe actions (notify/webhook + the `rss_*` delegated
   * actions) may run — torrent engine actions (move/pause/…) need a real torrent
   * and will error, which is caught and logged per rule. Best-effort: never
   * throws to its caller.
   */
  async evaluateEvent(
    trigger: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    const rules = await this.loadRules(trigger);
    for (const rule of rules) {
      const conditions = (rule.conditions as unknown as Condition[]) ?? [];
      if (
        !conditions.every((c) =>
          this.applyOperator(c.op, context[c.field as string], c.value),
        )
      ) {
        continue;
      }
      try {
        for (const action of (rule.actions as unknown as Action[]) ?? []) {
          await this.runEventAction(action, context);
        }
        await this.logEvent(rule, 'success', context, null);
      } catch (err) {
        await this.logEvent(rule, 'failed', context, (err as Error).message);
        await this.notifications.dispatch({
          level: 'error',
          title: 'Automation failed',
          message: `Rule "${rule.name}" failed: ${(err as Error).message}`,
          eventType: 'automation.failed',
        });
      }
    }
  }

  /** Actions runnable without a torrent: notifications, webhooks, RSS delegates. */
  private async runEventAction(
    action: Action,
    context: Record<string, unknown>,
  ): Promise<void> {
    const params = action.params ?? {};

    if (RSS_ACTION_TYPES.has(action.type)) {
      await this.rssActions.execute(action.type, params, context);
      return;
    }

    if (SUBTITLE_ACTION_TYPES.has(action.type)) {
      await this.subtitleActions.execute(action.type, params, context);
      return;
    }

    // Media actions were reachable only from the torrent-completion path
    // (`runAction`), never from an event trigger — so a rule on `media.*` or
    // `rss.*` could not run one. The duplicate actions are event-driven by nature
    // (a scan-completed rule that runs a report), so event context has to delegate
    // them too.
    if (MEDIA_ACTION_TYPES.has(action.type)) {
      await this.mediaActions.execute(action.type, params);
      return;
    }

    switch (action.type) {
      case 'notify':
      case 'notify_admin':
        await this.notifications.dispatch({
          level: action.type === 'notify_admin' ? 'warning' : 'info',
          title: String(params.title ?? 'Automation'),
          message: String(params.message ?? context.title ?? ''),
        });
        break;
      case 'send_notification':
        await this.sendViaCenter(params, context);
        break;
      case 'webhook':
        await this.postWebhook(params.url, { event: context, params });
        break;
      default:
        throw new Error(`Action "${action.type}" is not valid for an event trigger`);
    }
  }

  /**
   * POST a webhook payload to a rule-supplied URL, SSRF-guarded. Without this a rule
   * author could point the action at `http://169.254.169.254/…` (cloud metadata),
   * a Docker-internal service, or a localhost admin port. The guard blocks internal
   * addresses (operator opt-in via SSRF_ALLOW_HOSTS for a legitimate LAN hook) and
   * `redirect: 'error'` stops a 3xx bouncing past it; a bounded timeout caps hangs.
   */
  private async postWebhook(url: unknown, payload: Record<string, unknown>): Promise<void> {
    const safe = await assertSafeOutboundUrl(String(url ?? ''));
    await fetch(safe.toString(), {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
  }

  /** Dispatch through the Notification Center (the `send_notification` action). */
  private async sendViaCenter(params: Record<string, unknown>, context: Record<string, unknown>): Promise<void> {
    await this.moduleRef.get(NotificationCenterService, { strict: false }).dispatchDirect({
      channelIds: params.channelIds as string[] | undefined,
      recipientIds: params.recipientIds as string[] | undefined,
      groupIds: params.groupIds as string[] | undefined,
      templateId: params.templateId as string | undefined,
      variables: { ...context, ...((params.variables as Record<string, unknown>) ?? {}) },
      priority: params.priority as number | undefined,
      title: (params.title as string) ?? (context.title as string) ?? undefined,
      message: (params.message as string) ?? undefined,
    });
  }

  private async logEvent(
    rule: AutomationRuleRef,
    status: string,
    context: Record<string, unknown>,
    message: string | null,
  ): Promise<void> {
    await this.prisma.automationLog.create({
      data: { ruleId: rule.id, status, message, context: context as object },
    });
    // Surface the run in the audit trail + Recent activity. objectType is the
    // rule itself (event triggers have no torrent to key on).
    await this.recordAudit(rule, status, message, {
      name: typeof context.title === 'string' ? context.title : undefined,
    }, 'automation_rule', rule.id);
  }

  /** Action `type` strings of a rule, for the audit metadata. */
  private actionTypes(actions: unknown): string[] {
    return Array.isArray(actions)
      ? (actions as Action[]).map((a) => a?.type).filter((t): t is string => !!t)
      : [];
  }

  /**
   * Mirror an automation-rule run into the audit log so it shows up in the audit
   * trail and the dashboard's Recent activity. Best-effort — `AuditService.record`
   * never throws into the automation path.
   */
  private async recordAudit(
    rule: AutomationRuleRef,
    status: string,
    message: string | null,
    extra: Record<string, unknown>,
    objectType: string,
    objectId: string | undefined,
  ): Promise<void> {
    await this.audit.record({
      action: 'automation.rule.executed',
      result: status === 'failed' ? 'failure' : 'success',
      objectType,
      objectId,
      metadata: {
        rule: rule.name,
        actions: this.actionTypes(rule.actions),
        ...extra,
        ...(message ? { error: message } : {}),
      },
    });
  }

  private loadRules(trigger: string) {
    return this.prisma.automationRule.findMany({
      where: { trigger, isEnabled: true },
      orderBy: { priority: 'desc' },
    });
  }

  /**
   * Run each rule whose conditions match `context`. When `previous` is supplied
   * (periodic triggers), a rule fires only on the RISING EDGE — i.e. when its
   * conditions were NOT already satisfied by the previous torrent state — so a
   * poll-driven trigger like `ratio.reached` fires once as the threshold is
   * crossed, not on every subsequent poll.
   */
  private async applyRules(
    rules: Array<{
      id: string;
      name: string;
      conditions: unknown;
      actions: unknown;
    }>,
    context: NormalizedTorrent,
    previous?: NormalizedTorrent,
  ): Promise<void> {
    for (const rule of rules) {
      const conditions = (rule.conditions as unknown as Condition[]) ?? [];
      if (!conditions.every((c) => this.checkCondition(c, context))) continue;
      if (
        previous &&
        conditions.every((c) => this.checkCondition(c, previous))
      ) {
        continue; // already satisfied last cycle — not a rising edge
      }

      try {
        for (const action of (rule.actions as unknown as Action[]) ?? []) {
          await this.runAction(action, context);
        }
        await this.log(rule, 'success', context, null);
      } catch (err) {
        await this.log(rule, 'failed', context, (err as Error).message);
        await this.notifications.dispatch({
          level: 'error',
          title: 'Automation failed',
          message: `Rule "${rule.name}" failed: ${(err as Error).message}`,
          eventType: 'automation.failed',
        });
      }
    }
  }

  private checkCondition(c: Condition, t: NormalizedTorrent): boolean {
    return this.applyOperator(c.op, t[c.field] as unknown, c.value);
  }

  /** The comparison logic shared by torrent-context and event-context rules. */
  private applyOperator(op: string, actual: unknown, value: unknown): boolean {
    switch (op) {
      case 'eq':
        return actual === value;
      case 'neq':
        return actual !== value;
      case 'gt':
        return Number(actual) > Number(value);
      case 'gte':
        return Number(actual) >= Number(value);
      case 'lt':
        return Number(actual) < Number(value);
      case 'lte':
        return Number(actual) <= Number(value);
      case 'contains':
        return String(actual).includes(String(value));
      case 'matches':
        try {
          return new RegExp(String(value), 'i').test(String(actual));
        } catch {
          return false;
        }
      default:
        return false;
    }
  }

  private async runAction(
    action: Action,
    t: NormalizedTorrent,
  ): Promise<void> {
    const params = action.params ?? {};

    // Subtitle Intelligence actions delegate to SubtitleAutomationActions.
    if (SUBTITLE_ACTION_TYPES.has(action.type)) {
      await this.subtitleActions.execute(action.type, params, { title: t.name });
      return;
    }

    // Media Manager actions delegate to MediaAutomationActions (no engine needed).
    if (MEDIA_ACTION_TYPES.has(action.type)) {
      await this.mediaActions.execute(action.type, params);
      return;
    }

    switch (action.type) {
      case 'move':
        await (await this.registry.resolve(t.engineId)).moveStorage(
          t.hash,
          String(params.destination),
        );
        break;
      case 'pause':
        await (await this.registry.resolve(t.engineId)).pauseTorrent(t.hash);
        break;
      case 'stop':
        await (await this.registry.resolve(t.engineId)).stopTorrent(t.hash);
        break;
      case 'delete':
        await (await this.registry.resolve(t.engineId)).removeTorrent(t.hash);
        break;
      case 'delete_with_data':
        await (await this.registry.resolve(t.engineId)).removeTorrentAndData(
          t.hash,
        );
        break;
      case 'notify':
      case 'media_notify':
        await this.notifications.dispatch({
          level: 'info',
          title: String(params.title ?? 'Automation'),
          message: String(params.message ?? t.name),
        });
        break;
      case 'send_notification':
        await this.sendViaCenter(params, { title: t.name, mediaTitle: t.name, torrentName: t.name, hash: t.hash });
        break;
      case 'webhook':
        await this.postWebhook(params.url, { torrent: t, params });
        break;
      case 'rename_for_media':
        await this.media.apply({
          hash: t.hash,
          engineId: t.engineId,
          preset: params.preset as never,
          mode: (params.mode ?? 'hardlink') as never,
          libraryPath: String(params.libraryPath ?? ''),
          template: params.template as string | undefined,
        });
        break;
      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }
  }

  private async log(
    rule: AutomationRuleRef,
    status: string,
    context: NormalizedTorrent,
    message: string | null,
  ): Promise<void> {
    await this.prisma.automationLog.create({
      data: {
        ruleId: rule.id,
        status,
        message,
        context: { hash: context.hash, name: context.name } as object,
      },
    });
    await this.recordAudit(
      rule,
      status,
      message,
      { name: context.name, hash: context.hash },
      'torrent',
      context.hash,
    );
  }
}

@Injectable()
export class AutomationService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.automationRule.findMany({ orderBy: { priority: 'desc' } });
  }
  create(dto: UpsertRuleDto) {
    return this.prisma.automationRule.create({
      data: {
        name: dto.name,
        description: dto.description,
        trigger: dto.trigger,
        conditions: dto.conditions as object,
        actions: dto.actions as object,
        isEnabled: dto.isEnabled ?? true,
        priority: dto.priority ?? 0,
      },
    });
  }
  update(id: string, dto: UpsertRuleDto) {
    return this.prisma.automationRule.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        trigger: dto.trigger,
        conditions: dto.conditions as object,
        actions: dto.actions as object,
        isEnabled: dto.isEnabled,
        priority: dto.priority,
      },
    });
  }
  remove(id: string) {
    return this.prisma.automationRule.delete({ where: { id } });
  }
  logs(ruleId: string, page?: string, pageSize?: string) {
    return paginate(
      this.prisma.automationLog,
      { where: { ruleId }, orderBy: { createdAt: 'desc' } },
      parsePage(page, pageSize),
    );
  }
}

@ApiTags('automation')
@ApiBearerAuth()
@Controller('automation')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AutomationController {
  constructor(private readonly svc: AutomationService) {}

  @Get('catalog')
  @RequirePermissions(PERMISSIONS.AUTOMATION_VIEW)
  catalog() {
    return { triggers: AUTOMATION_TRIGGERS, actions: AUTOMATION_ACTIONS };
  }

  @Get('rules')
  @RequirePermissions(PERMISSIONS.AUTOMATION_VIEW)
  list() {
    return this.svc.list();
  }
  @Post('rules')
  @RequirePermissions(PERMISSIONS.AUTOMATION_MANAGE)
  create(@Body() dto: UpsertRuleDto, @Req() req: Request) {
    return this.svc.create({ ...dto, ...rawJson(req) });
  }
  @Patch('rules/:id')
  @RequirePermissions(PERMISSIONS.AUTOMATION_MANAGE)
  update(
    @Param('id') id: string,
    @Body() dto: UpsertRuleDto,
    @Req() req: Request,
  ) {
    return this.svc.update(id, { ...dto, ...rawJson(req) });
  }
  @Delete('rules/:id')
  @RequirePermissions(PERMISSIONS.AUTOMATION_MANAGE)
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }
  @Get('rules/:id/logs')
  @RequirePermissions(PERMISSIONS.AUTOMATION_VIEW)
  logs(@Param('id') id: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.svc.logs(id, page, pageSize);
  }
}

/**
 * Bridges Unified Jobs Center operational events (published to the domain-event bus
 * by `PlatformJobService`) into the automation engine, so users can build rules that
 * react to `job.failed` / `job.stalled` / `job.completed_with_warnings` /
 * `job.retry_exhausted`. Decoupled: automation subscribes to the bus; the Jobs Center
 * never imports automation. Only `job.*` events are forwarded.
 */
@Injectable()
export class JobAutomationBridge {
  private readonly logger = new Logger(JobAutomationBridge.name);
  constructor(private readonly engine: AutomationEngine) {}

  @OnEvent(NOTIFICATION_BUS_CHANNEL)
  async onDomainEvent(envelope: DomainEventEnvelope): Promise<void> {
    if (!envelope?.event?.startsWith('job.')) return;
    try {
      await this.engine.evaluateEvent(envelope.event, envelope.payload ?? {});
    } catch (err) {
      this.logger.debug(`Automation evaluate for ${envelope.event} failed: ${(err as Error).message}`);
    }
  }
}

@Global()
@Module({
  // forwardRef guards the ES-module load-order cycle: RSS files import
  // AutomationEngine (for ModuleRef-based trigger firing) while this module
  // imports RssModule (for the RssAutomationActions delegate). The DI graph
  // itself is acyclic (RssModule never imports AutomationModule).
  imports: [forwardRef(() => RssModule)],
  providers: [AutomationEngine, AutomationService, JobAutomationBridge],
  controllers: [AutomationController],
  exports: [AutomationEngine],
})
export class AutomationModule {}
