import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { CapabilityRegistry } from '../context-actions/capability-registry.service';
import { SUBTITLE_ACTIONS } from './subtitle-actions';
import { SettingsModule } from '../settings/settings.module';
import { FilesModule } from '../files/files.module';
import { SecretCipher } from '../../common/crypto/secret-cipher';
import { SubtitleIntelligenceController } from './subtitle-intelligence.controller';
import { SubtitleService } from './subtitle.service';
import { SubtitleProviderRegistry } from './providers/provider-registry.service';
import { SubtitleProviderSettingsService } from './providers/subtitle-provider-settings.service';
import { VideoFingerprintService } from './fingerprint/video-fingerprint.service';
import { SubtitleInstallService } from './pipeline/subtitle-install.service';
import { SubtitleQueueService } from './jobs/subtitle-queue.service';
import { SubtitleSyncService } from './sync/subtitle-sync.service';
import { SubtitleMissingScanService } from './jobs/subtitle-missing-scan.service';
import { SubtitleSchedulers } from './jobs/subtitle-schedulers.service';
import { SubtitleTriggerService } from './automation/subtitle-trigger.service';
import { SubtitleAutomationActions } from './automation/subtitle-automation.actions';
import { SubtitleSettingsService } from './settings/subtitle-settings.service';

/**
 * Subtitle Intelligence (core module `subtitle_intelligence`) — the definitive
 * subtitle acquisition, validation, and synchronization engine. Fingerprints a
 * media file, searches providers with a progressively-relaxed strategy, scores +
 * validates each candidate, and installs the best as a media-server-correct
 * sidecar (which media_manager's scanner then discovers), never overwriting an
 * original. Filesystem access is confined by FilePathService (FilesModule);
 * provider credentials are AES-256-GCM encrypted at rest with SecretCipher.
 *
 * PrismaService, RealtimeGateway, AuditService and the EventEmitter bus are all
 * globally provided, so only Settings + Files are imported explicitly.
 */
@Global()
@Module({
  imports: [SettingsModule, FilesModule],
  providers: [
    SecretCipher,
    SubtitleProviderSettingsService,
    SubtitleProviderRegistry,
    VideoFingerprintService,
    SubtitleInstallService,
    SubtitleQueueService,
    SubtitleSyncService,
    SubtitleTriggerService,
    SubtitleSettingsService,
    SubtitleMissingScanService,
    SubtitleAutomationActions,
    SubtitleSchedulers,
    SubtitleService,
  ],
  controllers: [SubtitleIntelligenceController],
  exports: [
    SubtitleService,
    SubtitleSyncService,
    SubtitleProviderRegistry,
    VideoFingerprintService,
    SubtitleMissingScanService,
    SubtitleAutomationActions,
  ],
})
/**
 * Contributes the subtitle actions, and seeds provider availability at boot.
 *
 * The seed matters: provider capability is a snapshot the registry holds in
 * memory, so without it a restart would leave every subtitle action withheld
 * until the next scheduled health check — the feature would look removed rather
 * than pending.
 */
export class SubtitleIntelligenceModule implements OnModuleInit {
  constructor(
    private readonly capabilities: CapabilityRegistry,
    private readonly providerSettings: SubtitleProviderSettingsService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.capabilities.registerAll(SUBTITLE_ACTIONS);
    await this.providerSettings.publishActionCapability();
  }
}
