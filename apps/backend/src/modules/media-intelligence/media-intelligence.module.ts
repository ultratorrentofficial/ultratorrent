import { Injectable, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DOMAIN_EVENTS, MODULE_IDS } from '@ultratorrent/shared';

import { DomainEventBus } from '../domain-events/domain-event-bus.service';
import { ModuleRegistryService } from '../module-registry/module-registry.service';
import { MediaAcquisitionModule } from '../media-acquisition/media-acquisition.module';
import { MediaIntelligenceController } from './media-intelligence.controller';
import { MediaIntelligenceProjectionService } from './media-intelligence-projection.service';
import { MediaIntelligenceService } from './media-intelligence.service';
import { MediaStateAssembler } from './media-state.assembler';
import { QualityPreferenceResolver } from './quality/preference-resolution.service';
import { AttentionService } from './attention/attention.service';
import { AttentionDispositionService } from './attention/attention-disposition.service';
import { CapabilityRegistry } from '../context-actions/capability-registry.service';
import { MEDIA_INTELLIGENCE_ACTIONS } from './media-intelligence-actions';

/** Reconcile the projection this often. */
const RECONCILE_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * Keeps the derived projection honest.
 *
 * **Periodic reconciliation is the primary refresh path, not a safety net.**
 * That is forced by the event catalogue rather than chosen: there is no
 * `library.scan.completed`, no `media.metadata.updated`, no
 * `media.technical.probed`, no acquisition-grabbed and no intake-completed
 * domain event in this codebase, and the catalogue's own rule is that a key
 * exists only when something really publishes it. Inventing those keys would
 * mean registering events nothing fires. So the four keys that genuinely fire
 * are used as cheap invalidation hints, and a slow full sweep is what actually
 * guarantees the projection converges.
 *
 * The sweep is deliberately conservative: it no-ops unless Media Manager is
 * enabled, never awaits into the timer, and rebuilds rather than patching —
 * the source domains are the truth and a full recompute cannot drift from them.
 */
@Injectable()
export class MediaIntelligenceReconciler implements OnModuleInit {
  private readonly logger = new Logger(MediaIntelligenceReconciler.name);
  /** Entities whose facts an event suggested may have moved. */
  private readonly dirty = new Set<string>();

  constructor(
    private readonly bus: DomainEventBus,
    private readonly registry: ModuleRegistryService,
    private readonly projections: MediaIntelligenceProjectionService,
  ) {}

  /*
   * Guards on this module's own id, not on `media_manager`. The dependency on
   * Media Manager is declared in the manifest and enforced by the registry, so
   * checking it by hand here would be a second, divergent copy of that rule —
   * and it would leave the sweep running after an operator switched
   * Intelligence itself off.
   */
  private get enabled(): boolean {
    return this.registry.getStatus(MODULE_IDS.MEDIA_INTELLIGENCE)?.enabled ?? false;
  }

  onModuleInit(): void {
    // Only these four exist. A torrent finishing or a file moving is the real
    // "media on disk changed" signal in this system; everything else about a
    // media entity changes silently and is caught by the sweep.
    const watched = new Set<string>([
      DOMAIN_EVENTS.TORRENT_COMPLETED,
      DOMAIN_EVENTS.TORRENT_FAILED,
      DOMAIN_EVENTS.FILE_MOVED,
      DOMAIN_EVENTS.FILE_DELETED,
    ]);
    this.bus.subscribe('media-intelligence', (envelope) => {
      if (!watched.has(envelope.eventKey)) return;
      // Deliberately only a hint: these events carry a hash or a path, not a
      // media entity id, and guessing which entity they touched would be the
      // loose mapping this layer exists to avoid. The marker just tells the
      // next sweep that the world moved.
      this.dirty.add(envelope.eventKey);
    });
  }

  @Interval('media_intelligence_reconcile', RECONCILE_INTERVAL_MS)
  reconcile(): void {
    if (!this.enabled) return;
    const hinted = this.dirty.size > 0;
    this.dirty.clear();
    void this.projections
      .rebuildAll()
      .then((s) => {
        if (!s.skipped) {
          this.logger.log(
            `Reconciled Media Intelligence${hinted ? ' (source events seen)' : ''}: ` +
              `${s.movies} movies, ${s.series} series, ${s.failed} failed.`,
          );
        }
      })
      .catch((err) => this.logger.warn(`Media Intelligence reconcile failed: ${(err as Error).message}`));
  }
}

/**
 * Media Intelligence — Phase 1: Unified Media State & Health.
 *
 * Observational and advisory. It correlates facts the owning domains already
 * store into one explainable view and draws conclusions from them; it never
 * downloads, deletes, transcodes, repairs, re-tags or unseeds anything.
 *
 * `imports` carries only `MediaAcquisitionModule`, for `MissingEpisodesService`.
 * `PrismaModule`, `AuditModule` and `MediaModule` are all `@Global`, so
 * `PrismaService`, `AuditService` and `MediaLinkageService` resolve without an
 * import edge — adding one would be a redundant cycle risk, not extra safety.
 */
@Module({
  imports: [MediaAcquisitionModule],
  controllers: [MediaIntelligenceController],
  providers: [
    MediaStateAssembler,
    QualityPreferenceResolver,
    AttentionService,
    AttentionDispositionService,
    MediaIntelligenceProjectionService,
    MediaIntelligenceService,
    MediaIntelligenceReconciler,
  ],
  // Exported so a future Attention Center (Phase 3) can read findings without
  // going through HTTP.
  exports: [MediaIntelligenceService, MediaIntelligenceProjectionService, AttentionService],
})
export class MediaIntelligenceModule implements OnModuleInit {
  constructor(private readonly capabilities: CapabilityRegistry) {}

  /**
   * Disposition actions, declared to CAMA rather than to the page.
   *
   * The Attention Center must not grow a private action framework: what an
   * operator may do to a finding is decided by the same registry, and the
   * same permission resolution, as everything else in the product.
   */
  onModuleInit(): void {
    this.capabilities.registerAll(MEDIA_INTELLIGENCE_ACTIONS);
  }
}
