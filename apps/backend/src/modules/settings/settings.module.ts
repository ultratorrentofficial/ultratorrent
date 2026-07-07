import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Param,
  Patch,
  Put,
  Req,
  UseGuards,
  Module,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsDefined } from 'class-validator';
import { Prisma } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PERMISSIONS, NOTIFICATION_BUS_CHANNEL, NOTIFICATION_EVENTS } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';

class SetSettingDto {
  @IsDefined()
  value!: unknown;
}

/**
 * Keys that must NOT be writable through the generic settings endpoints — they
 * have dedicated, validated + audited routes. `fileManager.defaultRootPath` is
 * owned by `PUT /api/files/root` (permission `settings.manage_root_path`,
 * path validated against FILE_MANAGER_ROOTS); allowing it here would bypass
 * that validation and permission.
 */
const PROTECTED_SETTING_KEYS = new Set<string>(['fileManager.defaultRootPath']);

function assertNotProtected(key: string): void {
  if (PROTECTED_SETTING_KEYS.has(key)) {
    throw new ForbiddenException(
      `"${key}" cannot be changed here — use PUT /api/files/root.`,
    );
  }
}

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventEmitter2,
  ) {}

  async getAll(): Promise<Record<string, unknown>> {
    const rows = await this.prisma.setting.findMany();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async get<T = unknown>(key: string, fallback?: T): Promise<T | undefined> {
    const row = await this.prisma.setting.findUnique({ where: { key } });
    return (row?.value as T) ?? fallback;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.prisma.setting.upsert({
      where: { key },
      update: { value: value as Prisma.InputJsonValue },
      create: { key, value: value as Prisma.InputJsonValue },
    });
    // Don't echo the (possibly sensitive) value onto the bus — just the key.
    this.eventBus.emit(NOTIFICATION_BUS_CHANNEL, {
      event: NOTIFICATION_EVENTS.SYSTEM_SETTINGS_CHANGED,
      payload: { settingKey: key, mediaTitle: key },
      at: new Date().toISOString(),
    });
  }
}

@ApiTags('settings')
@ApiBearerAuth()
@Controller('settings')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.SETTINGS_VIEW)
  all() {
    return this.settings.getAll();
  }

  @Put(':key')
  @RequirePermissions(PERMISSIONS.SETTINGS_MANAGE)
  async set(@Param('key') key: string, @Body() dto: SetSettingDto) {
    assertNotProtected(key);
    await this.settings.set(key, dto.value);
    return { key, value: dto.value };
  }

  /** Bulk patch: { "general.theme": "dark", ... } — upserts each key. */
  @Patch()
  @RequirePermissions(PERMISSIONS.SETTINGS_MANAGE)
  async patch(@Req() req: Request) {
    // Read the raw body so the global whitelist pipe doesn't strip dynamic keys.
    const body = (req.body ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(body)) assertNotProtected(key);
    await Promise.all(
      Object.entries(body).map(([key, value]) => this.settings.set(key, value)),
    );
    return this.settings.getAll();
  }
}

@Module({
  providers: [SettingsService],
  controllers: [SettingsController],
  exports: [SettingsService],
})
export class SettingsModule {}
