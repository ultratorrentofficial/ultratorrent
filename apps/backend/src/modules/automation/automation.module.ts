import {
  Body,
  Controller,
  Delete,
  Get,
  Global,
  Injectable,
  Logger,
  Module,
  Param,
  Patch,
  Post,
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
import { NormalizedTorrent, PERMISSIONS } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { EngineRegistryService } from '../engine/engine-registry.service';
import { NotificationsService } from '../notifications/notifications.module';
import { MediaService } from '../media/media.service';
import { MediaAutomationActions } from '../media/media-automation.actions';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';

type Condition = { field: keyof NormalizedTorrent; op: string; value: unknown };
type Action = { type: string; params?: Record<string, unknown> };

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
] as const;

/** Catalog of actions the engine can execute (metadata for the UI). */
export const AUTOMATION_ACTIONS = [
  { id: 'notify', label: 'Send notification', category: 'torrent' },
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
] as const;

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
        await this.log(rule.id, 'success', context, null);
      } catch (err) {
        await this.log(rule.id, 'failed', context, (err as Error).message);
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
    const actual = t[c.field] as unknown;
    switch (c.op) {
      case 'eq':
        return actual === c.value;
      case 'neq':
        return actual !== c.value;
      case 'gt':
        return Number(actual) > Number(c.value);
      case 'gte':
        return Number(actual) >= Number(c.value);
      case 'lt':
        return Number(actual) < Number(c.value);
      case 'lte':
        return Number(actual) <= Number(c.value);
      case 'contains':
        return String(actual).includes(String(c.value));
      case 'matches':
        try {
          return new RegExp(String(c.value), 'i').test(String(actual));
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
      case 'webhook':
        await fetch(String(params.url), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ torrent: t, params }),
        });
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
    ruleId: string,
    status: string,
    context: NormalizedTorrent,
    message: string | null,
  ): Promise<void> {
    await this.prisma.automationLog.create({
      data: {
        ruleId,
        status,
        message,
        context: { hash: context.hash, name: context.name } as object,
      },
    });
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
  logs(ruleId: string) {
    return this.prisma.automationLog.findMany({
      where: { ruleId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
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
  logs(@Param('id') id: string) {
    return this.svc.logs(id);
  }
}

@Global()
@Module({
  providers: [AutomationEngine, AutomationService],
  controllers: [AutomationController],
  exports: [AutomationEngine],
})
export class AutomationModule {}
