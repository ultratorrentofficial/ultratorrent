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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';

type Condition = { field: keyof NormalizedTorrent; op: string; value: unknown };
type Action = { type: string; params?: Record<string, unknown> };

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
    const provider = await this.registry.resolve(t.engineId);
    const params = action.params ?? {};
    switch (action.type) {
      case 'move':
        await provider.moveStorage(t.hash, String(params.destination));
        break;
      case 'pause':
        await provider.pauseTorrent(t.hash);
        break;
      case 'stop':
        await provider.stopTorrent(t.hash);
        break;
      case 'delete':
        await provider.removeTorrent(t.hash);
        break;
      case 'delete_with_data':
        await provider.removeTorrentAndData(t.hash);
        break;
      case 'notify':
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
