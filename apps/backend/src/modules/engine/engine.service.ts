import { Injectable, NotFoundException } from '@nestjs/common';
import { EngineHealth, EngineKind } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { EngineProviderFactory } from '../../infrastructure/engine/engine-provider.factory';
import { EngineRegistryService } from './engine-registry.service';
import {
  CreateEngineDto,
  TestEngineDto,
  UpdateEngineDto,
} from './dto/engine.dto';

@Injectable()
export class EngineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: EngineRegistryService,
    private readonly factory: EngineProviderFactory,
  ) {}

  async list() {
    const engines = await this.prisma.torrentEngine.findMany({
      orderBy: { createdAt: 'asc' },
    });
    // Connection transport fields are non-secret (host/port/socket) so the UI
    // can prefill the edit form. Providers keep any real secrets out of config.
    return engines.map((e) => {
      const cfg = e.config as Record<string, unknown>;
      return {
        id: e.id,
        name: e.name,
        kind: e.kind,
        isDefault: e.isDefault,
        isEnabled: e.isEnabled,
        mode: cfg.mode,
        host: cfg.host,
        port: cfg.port,
        socketPath: cfg.socketPath,
        url: cfg.url,
        timeoutMs: cfg.timeoutMs,
      };
    });
  }

  /** Probe a connection config without persisting it (used by the UI form). */
  async test(dto: TestEngineDto): Promise<EngineHealth> {
    try {
      const provider = this.factory.create({
        kind: dto.kind as EngineKind,
        engineId: 'connection-test',
        mode: dto.config.mode,
        host: dto.config.host,
        port: dto.config.port,
        socketPath: dto.config.socketPath,
        url: dto.config.url,
        timeoutMs: dto.config.timeoutMs,
      });
      return await provider.healthCheck();
    } catch (err) {
      return {
        online: false,
        latencyMs: null,
        version: null,
        error: (err as Error).message,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  async create(dto: CreateEngineDto) {
    if (dto.isDefault) {
      await this.prisma.torrentEngine.updateMany({
        data: { isDefault: false },
      });
    }
    const engine = await this.prisma.torrentEngine.create({
      data: {
        name: dto.name,
        kind: dto.kind,
        config: dto.config as object,
        isDefault: dto.isDefault ?? false,
        isEnabled: dto.isEnabled ?? true,
      },
    });
    await this.registry.reload();
    return { id: engine.id };
  }

  async update(id: string, dto: UpdateEngineDto) {
    const existing = await this.prisma.torrentEngine.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Engine not found');
    if (dto.isDefault) {
      await this.prisma.torrentEngine.updateMany({
        data: { isDefault: false },
      });
    }
    await this.prisma.torrentEngine.update({
      where: { id },
      data: {
        name: dto.name,
        config: dto.config ? (dto.config as object) : undefined,
        isDefault: dto.isDefault,
        isEnabled: dto.isEnabled,
      },
    });
    await this.registry.reload();
    return { id };
  }

  async remove(id: string) {
    await this.prisma.torrentEngine.delete({ where: { id } });
    await this.registry.reload();
    return { id };
  }

  async health(id?: string): Promise<EngineHealth> {
    const provider = await this.registry.resolve(id);
    return provider.healthCheck();
  }
}
