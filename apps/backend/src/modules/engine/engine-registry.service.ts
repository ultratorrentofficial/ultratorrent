import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { EngineKind } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { EngineProviderFactory } from '../../infrastructure/engine/engine-provider.factory';
import { SecretCipher } from '../../common/crypto/secret-cipher';
import { decryptEngineConfig } from './engine-secrets';
import {
  EngineConnectionConfig,
  TorrentEngineProvider,
} from '../../domain/engine/torrent-engine-provider.interface';

/**
 * Owns the lifecycle of live {@link TorrentEngineProvider} instances. Resolves
 * providers by engine id and exposes the default engine. The rest of the
 * application talks to providers exclusively through this registry.
 */
@Injectable()
export class EngineRegistryService implements OnModuleInit {
  private readonly logger = new Logger(EngineRegistryService.name);
  private readonly providers = new Map<string, TorrentEngineProvider>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly factory: EngineProviderFactory,
    private readonly cipher: SecretCipher,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  /** Rebuild all provider instances from the database. */
  async reload(): Promise<void> {
    this.providers.clear();
    const engines = await this.prisma.torrentEngine.findMany({
      where: { isEnabled: true },
    });
    for (const engine of engines) {
      try {
        // Decrypt any at-rest secrets (e.g. qBittorrent password) before the
        // provider connects.
        const cfg = decryptEngineConfig(
          this.cipher,
          engine.config as Record<string, unknown>,
        );
        const provider = this.factory.create({
          kind: engine.kind as EngineKind,
          engineId: engine.id,
          mode: cfg.mode as EngineConnectionConfig['mode'],
          host: cfg.host as string | undefined,
          port: cfg.port as number | undefined,
          socketPath: cfg.socketPath as string | undefined,
          url: cfg.url as string | undefined,
          timeoutMs: cfg.timeoutMs as number | undefined,
          baseUrl: cfg.baseUrl as string | undefined,
          username: cfg.username as string | undefined,
          password: cfg.password as string | undefined,
        });
        this.providers.set(engine.id, provider);
      } catch (err) {
        this.logger.error(
          `Failed to initialise engine ${engine.name}: ${(err as Error).message}`,
        );
      }
    }
    this.logger.log(`Loaded ${this.providers.size} engine provider(s)`);
  }

  list(): TorrentEngineProvider[] {
    return [...this.providers.values()];
  }

  get(engineId: string): TorrentEngineProvider {
    const provider = this.providers.get(engineId);
    if (!provider) {
      throw new NotFoundException(`Engine ${engineId} is not available`);
    }
    return provider;
  }

  async getDefault(): Promise<TorrentEngineProvider> {
    const def = await this.prisma.torrentEngine.findFirst({
      where: { isEnabled: true, isDefault: true },
    });
    const id =
      def?.id ?? [...this.providers.keys()][0];
    if (!id) throw new NotFoundException('No torrent engine is configured');
    return this.get(id);
  }

  /** Resolve a provider, falling back to the default engine when id is absent. */
  async resolve(engineId?: string): Promise<TorrentEngineProvider> {
    return engineId ? this.get(engineId) : this.getDefault();
  }
}
