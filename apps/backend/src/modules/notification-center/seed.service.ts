import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { MODULE_IDS, NOTIFICATION_EVENTS as E } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ModuleRegistryService } from '../module-registry/module-registry.service';

const DEFAULT_GROUPS = ['Administrators', 'Operators', 'Media Users', 'Developers', 'Support', 'Executives'];

interface SeedRule {
  name: string;
  event: string;
  enabled: boolean;
  severity: 'info' | 'warning' | 'critical';
  description?: string;
}

/**
 * The default, fully-editable notification catalog. Seeded once (when no system
 * rules exist) so nothing is hardcoded — admins edit/disable/delete freely.
 * Rules target the Administrators group and the default channel(s); they match
 * immediately but only deliver once a channel is configured.
 */
const CATALOG: SeedRule[] = [
  // Media Server Analytics
  { name: 'User Started Watching', event: E.MEDIA_SERVER_USER_STARTED_WATCHING, enabled: false, severity: 'info', description: 'Rich now-playing card. Disabled by default (can be noisy).' },
  { name: 'User Finished Watching', event: E.MEDIA_SERVER_USER_FINISHED_WATCHING, enabled: false, severity: 'info' },
  { name: 'User Paused Playback', event: E.MEDIA_SERVER_USER_PAUSED, enabled: false, severity: 'info' },
  { name: 'User Resumed Playback', event: E.MEDIA_SERVER_USER_RESUMED, enabled: false, severity: 'info' },
  { name: 'User Stopped Playback', event: E.MEDIA_SERVER_USER_STOPPED, enabled: false, severity: 'info' },
  { name: 'New Media Added', event: E.MEDIA_SERVER_MEDIA_ADDED, enabled: true, severity: 'info' },
  { name: 'Recently Upgraded', event: E.MEDIA_SERVER_MEDIA_UPGRADED, enabled: true, severity: 'info' },
  { name: 'Media Server Offline', event: E.MEDIA_SERVER_SERVER_OFFLINE, enabled: true, severity: 'critical' },
  { name: 'Media Server Online', event: E.MEDIA_SERVER_SERVER_ONLINE, enabled: true, severity: 'info' },
  { name: 'Newsletter Sent', event: E.MEDIA_SERVER_NEWSLETTER_SENT, enabled: true, severity: 'info' },
  { name: 'Newsletter Failed', event: E.MEDIA_SERVER_NEWSLETTER_FAILED, enabled: true, severity: 'critical' },
  { name: 'Excessive Transcoding', event: E.MEDIA_SERVER_TRANSCODE_DETECTED, enabled: true, severity: 'warning' },
  { name: 'High Bandwidth Usage', event: E.MEDIA_SERVER_HIGH_BANDWIDTH, enabled: true, severity: 'warning' },
  // Downloads
  { name: 'Torrent Added', event: E.DOWNLOAD_TORRENT_ADDED, enabled: false, severity: 'info' },
  { name: 'Torrent Started', event: E.DOWNLOAD_TORRENT_STARTED, enabled: false, severity: 'info' },
  { name: 'Torrent Completed', event: E.DOWNLOAD_TORRENT_COMPLETED, enabled: true, severity: 'info' },
  { name: 'Torrent Failed', event: E.DOWNLOAD_TORRENT_FAILED, enabled: true, severity: 'critical' },
  { name: 'Download Stalled', event: E.DOWNLOAD_STALLED, enabled: true, severity: 'warning' },
  { name: 'Ratio Reached', event: E.DOWNLOAD_RATIO_REACHED, enabled: false, severity: 'info' },
  { name: 'Category Changed', event: E.DOWNLOAD_CATEGORY_CHANGED, enabled: false, severity: 'info' },
  // RSS
  { name: 'RSS Feed Failed', event: E.RSS_FEED_FAILED, enabled: true, severity: 'warning' },
  { name: 'RSS Rule Matched', event: E.RSS_RULE_MATCHED, enabled: false, severity: 'info' },
  { name: 'Candidate Approved', event: E.RSS_CANDIDATE_APPROVED, enabled: false, severity: 'info' },
  { name: 'Candidate Rejected', event: E.RSS_CANDIDATE_REJECTED, enabled: false, severity: 'info' },
  { name: 'Inactive Series Warning', event: E.RSS_INACTIVE_SERIES_WARNING, enabled: true, severity: 'warning' },
  { name: 'New Episode Available', event: E.RSS_NEW_EPISODE_AVAILABLE, enabled: false, severity: 'info' },
  // Media Manager
  { name: 'Metadata Match Failed', event: E.MEDIA_METADATA_MATCH_FAILED, enabled: true, severity: 'warning' },
  { name: 'Missing Artwork', event: E.MEDIA_MISSING_ARTWORK, enabled: false, severity: 'info' },
  { name: 'Missing Subtitles', event: E.MEDIA_MISSING_SUBTITLES, enabled: false, severity: 'info' },
  { name: 'Media Renamed', event: E.MEDIA_RENAMED, enabled: false, severity: 'info' },
  { name: 'Media Processing Completed', event: E.MEDIA_PROCESSING_COMPLETED, enabled: false, severity: 'info' },
  { name: 'Media Processing Failed', event: E.MEDIA_PROCESSING_FAILED, enabled: true, severity: 'critical' },
  { name: 'Duplicate Media', event: E.MEDIA_DUPLICATE, enabled: true, severity: 'warning' },
  { name: 'Duplicate Detected', event: E.MEDIA_DUPLICATE_DETECTED_EVENT, enabled: false, severity: 'info' },
  { name: 'Duplicate Needs Review', event: E.MEDIA_DUPLICATE_REVIEW_REQUIRED, enabled: false, severity: 'warning' },
  { name: 'Duplicate Savings Threshold', event: E.MEDIA_DUPLICATE_SAVINGS_THRESHOLD, enabled: false, severity: 'info' },
  { name: 'Duplicate Cleanup Completed', event: E.MEDIA_DUPLICATE_CLEANUP_COMPLETED, enabled: false, severity: 'info' },
  { name: 'Duplicate Cleanup Failed', event: E.MEDIA_DUPLICATE_CLEANUP_FAILED, enabled: true, severity: 'critical' },
  { name: 'Missing Episode Filled', event: E.MEDIA_MISSING_EPISODE_FILLED, enabled: false, severity: 'info' },
  { name: 'Library Scan Completed', event: E.MEDIA_LIBRARY_SCAN_COMPLETED, enabled: false, severity: 'info' },
  // System
  { name: 'Disk Space Low', event: E.SYSTEM_DISK_SPACE_LOW, enabled: true, severity: 'critical' },
  { name: 'CPU Usage High', event: E.SYSTEM_CPU_HIGH, enabled: true, severity: 'warning' },
  { name: 'Memory Usage High', event: E.SYSTEM_MEMORY_HIGH, enabled: true, severity: 'warning' },
  { name: 'Provider Offline', event: E.SYSTEM_PROVIDER_OFFLINE, enabled: true, severity: 'warning' },
  { name: 'Backup Failed', event: E.SYSTEM_BACKUP_FAILED, enabled: true, severity: 'critical' },
  { name: 'Database Error', event: E.SYSTEM_DATABASE_ERROR, enabled: true, severity: 'critical' },
  { name: 'Update Available', event: E.SYSTEM_UPDATE_AVAILABLE, enabled: true, severity: 'info' },
  { name: 'Security Alert', event: E.SYSTEM_SECURITY_ALERT, enabled: true, severity: 'critical' },
  { name: 'Failed Login', event: E.SYSTEM_FAILED_LOGIN, enabled: true, severity: 'warning' },
  { name: 'New Login', event: E.SYSTEM_NEW_LOGIN, enabled: false, severity: 'info' },
  { name: 'API Key Created', event: E.SYSTEM_API_KEY_CREATED, enabled: true, severity: 'warning' },
  { name: 'Settings Changed', event: E.SYSTEM_SETTINGS_CHANGED, enabled: false, severity: 'info' },
];

@Injectable()
export class NotificationSeedService implements OnModuleInit {
  private readonly logger = new Logger(NotificationSeedService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ModuleRegistryService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.registry.getStatus(MODULE_IDS.NOTIFICATION_CENTER)?.enabled) return;
    try {
      const adminsGroupId = await this.seedGroups();
      await this.seedRules(adminsGroupId);
    } catch (e) {
      this.logger.warn(`seed skipped: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async seedGroups(): Promise<string> {
    const existing = await this.prisma.notificationRecipientGroup.count({ where: { system: true } });
    if (existing === 0) {
      for (const name of DEFAULT_GROUPS) {
        await this.prisma.notificationRecipientGroup.upsert({
          where: { name },
          create: { name, system: true, description: `${name} recipient group` },
          update: {},
        });
      }
      this.logger.log(`Seeded ${DEFAULT_GROUPS.length} default recipient groups`);
    }
    const admins = await this.prisma.notificationRecipientGroup.findUnique({ where: { name: 'Administrators' } });
    return admins?.id ?? '';
  }

  private async seedRules(adminsGroupId: string): Promise<void> {
    const existing = await this.prisma.notificationRule.count({ where: { system: true } });
    if (existing > 0) return; // already seeded — never clobber admin edits
    await this.prisma.notificationRule.createMany({
      data: CATALOG.map((r) => ({
        name: r.name,
        description: r.description ?? null,
        enabled: r.enabled,
        event: r.event,
        severity: r.severity,
        recipients: { groupIds: adminsGroupId ? [adminsGroupId] : [], mapEventUser: false } as object,
        channelIds: [] as object,
        conditions: [] as object,
        system: true,
      })),
    });
    this.logger.log(`Seeded ${CATALOG.length} default notification rules`);
  }
}
