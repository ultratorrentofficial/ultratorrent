import { Injectable } from '@nestjs/common';
import { PERMISSIONS, SystemRole } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

/** The persisted job subsystems the aggregator spans. */
export type JobSubsystem =
  | 'media'
  | 'subtitle'
  | 'rename'
  | 'analytics_import'
  | 'notification';

/** Canonical, cross-subsystem job status. */
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/** One normalized job row, uniform across every subsystem. */
export interface JobSummary {
  id: string;
  subsystem: JobSubsystem;
  type: string;
  status: JobStatus;
  progress: number | null;
  label: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface JobQuery {
  subsystem?: JobSubsystem;
  status?: JobStatus;
  /** Only queued/running jobs. */
  active?: boolean;
  limit?: number;
}

/** The view permission that gates each subsystem (super-admin sees all). */
const SUBSYSTEM_PERMISSION: Record<JobSubsystem, string> = {
  media: PERMISSIONS.MEDIA_MANAGER_VIEW,
  subtitle: PERMISSIONS.SUBTITLE_INTELLIGENCE_VIEW,
  rename: PERMISSIONS.MEDIA_MANAGER_VIEW,
  analytics_import: PERMISSIONS.MEDIA_SERVER_ANALYTICS_VIEW,
  notification: PERMISSIONS.NOTIFICATIONS_VIEW,
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** Per-subsystem query cap before the merged result is sorted + sliced. */
const PER_SUBSYSTEM_CAP = 100;

function normalizeStatus(raw: string, leased?: boolean): JobStatus {
  const s = raw.toLowerCase();
  if (s === 'running' || s === 'preview') return 'running';
  if (s === 'completed' || s === 'rolled_back') return 'completed';
  if (s === 'failed') return 'failed';
  if (s === 'cancelled' || s === 'canceled') return 'cancelled';
  if (s === 'queued' || s === 'pending') return leased ? 'running' : 'queued';
  return 'queued';
}

function basename(p?: string | null): string | null {
  if (!p) return null;
  const parts = p.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/**
 * Read-only aggregator over the platform's persisted job tables
 * (`MediaProcessingJob`, `SubtitleJob`, `MediaRenameJob`, `MediaAnalyticsImportJob`,
 * `NotificationQueue`). Each subsystem is gated by its view permission, so a caller
 * only ever sees the jobs of subsystems they can view. This is the data behind every
 * workspace "Jobs" surface and the System global jobs view. It never mutates —
 * cancellation stays on each subsystem's own controller.
 */
@Injectable()
export class JobsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Subsystems this user may read (super-admin → all). */
  visibleSubsystems(user: AuthenticatedUser): JobSubsystem[] {
    const isSuper = user.roles?.includes(SystemRole.SUPER_ADMIN);
    const held = new Set(user.permissions ?? []);
    return (Object.keys(SUBSYSTEM_PERMISSION) as JobSubsystem[]).filter(
      (s) => isSuper || held.has(SUBSYSTEM_PERMISSION[s]),
    );
  }

  async list(user: AuthenticatedUser, query: JobQuery = {}): Promise<{ jobs: JobSummary[] }> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    let subsystems = this.visibleSubsystems(user);
    if (query.subsystem) subsystems = subsystems.filter((s) => s === query.subsystem);
    if (subsystems.length === 0) return { jobs: [] };

    const batches = await Promise.all(
      subsystems.map((s) => this.loadSubsystem(s)),
    );
    let jobs = batches.flat();

    if (query.status) jobs = jobs.filter((j) => j.status === query.status);
    if (query.active) jobs = jobs.filter((j) => j.status === 'queued' || j.status === 'running');

    jobs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return { jobs: jobs.slice(0, limit) };
  }

  private async loadSubsystem(subsystem: JobSubsystem): Promise<JobSummary[]> {
    switch (subsystem) {
      case 'media': {
        const rows = await this.prisma.mediaProcessingJob.findMany({
          orderBy: { createdAt: 'desc' },
          take: PER_SUBSYSTEM_CAP,
        });
        return rows.map((r) => ({
          id: r.id,
          subsystem,
          type: r.type,
          status: normalizeStatus(r.status),
          progress: r.progress,
          label: r.itemId ?? r.libraryId ?? null,
          error: r.error ?? null,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        }));
      }
      case 'subtitle': {
        const rows = await this.prisma.subtitleJob.findMany({
          orderBy: { createdAt: 'desc' },
          take: PER_SUBSYSTEM_CAP,
        });
        return rows.map((r) => ({
          id: r.id,
          subsystem,
          type: r.type,
          status: normalizeStatus(r.status),
          progress: r.progress,
          label: [r.itemId ?? r.libraryId, r.language].filter(Boolean).join(' · ') || null,
          error: r.error ?? null,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        }));
      }
      case 'rename': {
        const rows = await this.prisma.mediaRenameJob.findMany({
          orderBy: { createdAt: 'desc' },
          take: PER_SUBSYSTEM_CAP,
        });
        return rows.map((r) => ({
          id: r.id,
          subsystem,
          type: r.mode,
          status: normalizeStatus(r.status),
          progress: null,
          label: basename(r.sourcePath),
          error: null,
          createdAt: r.createdAt,
          updatedAt: r.completedAt ?? r.createdAt,
        }));
      }
      case 'analytics_import': {
        const rows = await this.prisma.mediaAnalyticsImportJob.findMany({
          orderBy: { createdAt: 'desc' },
          take: PER_SUBSYSTEM_CAP,
        });
        return rows.map((r) => ({
          id: r.id,
          subsystem,
          type: r.mode,
          status: normalizeStatus(r.status),
          progress: r.progress,
          label: r.sourceId,
          error: null,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        }));
      }
      case 'notification': {
        const rows = await this.prisma.notificationQueue.findMany({
          orderBy: { createdAt: 'desc' },
          take: PER_SUBSYSTEM_CAP,
        });
        return rows.map((r) => ({
          id: r.id,
          subsystem,
          type: 'delivery',
          status: normalizeStatus('queued', r.leasedAt != null),
          progress: null,
          label: r.deliveryId,
          error: null,
          createdAt: r.createdAt,
          updatedAt: r.leasedAt ?? r.createdAt,
        }));
      }
    }
  }
}
