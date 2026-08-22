import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  OPERATIONS_EVENT_CHANNEL,
  PERMISSIONS,
  type DomainEventEnvelope,
  type OperationsEvent,
} from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { DomainEventBus } from '../domain-events/domain-event-bus.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import {
  factsFor,
  jobSeverity,
  jobSummary,
  mappingFor,
  type JobEventLike,
} from './operations-event-map';

/**
 * How long a resolved display name is trusted, ms.
 *
 * Short enough that a rename shows up within a coffee break, long enough that a
 * burst of events from one person costs one query. The stream is a narrative,
 * not a directory — a name that is five minutes stale in a log line has never
 * been the problem worth a lookup per event.
 */
const ACTOR_CACHE_TTL_MS = 5 * 60_000;

/** Cap on remembered names, so a long uptime cannot grow this without bound. */
const ACTOR_CACHE_MAX = 500;

/**
 * The console's unified event feed.
 *
 * **This is a subscriber, not a bus.** It adds no producer, owns no queue and
 * persists nothing: it watches what the platform already emits, and re-emits a
 * bounded projection to console sockets that are permitted to read it. Turn it
 * off and every existing consumer of both sources is unaffected.
 *
 * It merges two sources because the platform genuinely has two:
 *
 * - `DomainEventBus` — the catalogued, validated, deduped facts (torrent
 *   completion, scheduler transitions, storage, providers, security, users).
 * - `jobs.*` on the gateway — the Unified Jobs Center's lifecycle events, which
 *   are emitted straight to realtime and never reach the bus.
 *
 * Historical depth is NOT this service's job. The ring buffer a console keeps is
 * what is currently on screen; the record of what happened is
 * `GET /api/audit`, and a console must not present the one as the other.
 */
@Injectable()
export class OperationsEventBridge implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OperationsEventBridge.name);
  private readonly unsubscribes: Array<() => void> = [];
  private readonly actorNames = new Map<string, { name: string | null; expiresAt: number }>();

  constructor(
    private readonly bus: DomainEventBus,
    private readonly realtime: RealtimeGateway,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.unsubscribes.push(
      this.bus.subscribe('operations-bridge', (envelope) => this.onDomainEvent(envelope)),
      this.realtime.observe((event, payload, permission) =>
        this.onRealtimeEmit(event, payload, permission),
      ),
    );
    this.logger.log(`Bridging platform events to "${OPERATIONS_EVENT_CHANNEL}"`);
  }

  onModuleDestroy(): void {
    for (const off of this.unsubscribes) off();
    this.unsubscribes.length = 0;
  }

  // -------------------------------------------------------------------------
  // Sources
  // -------------------------------------------------------------------------

  /**
   * A catalogued domain event.
   *
   * An unmapped key is dropped in silence rather than logged: the catalogue is
   * allowed to grow without every addition becoming console traffic, and a
   * warning per unmapped event would turn a deliberate default into log noise
   * on every install.
   */
  private async onDomainEvent(envelope: DomainEventEnvelope): Promise<void> {
    const mapping = mappingFor(envelope.eventKey);
    if (!mapping) return;

    const payload = (envelope.payload ?? {}) as Record<string, unknown>;
    const event: OperationsEvent = {
      id: envelope.id,
      at: envelope.occurredAt,
      eventKey: envelope.eventKey,
      category: mapping.category,
      severity: mapping.severity,
      summary: mapping.summary(payload, envelope),
      resourceType: envelope.resourceType ?? null,
      resourceId: envelope.resourceId ?? null,
      actor: await this.actorName(envelope.actorUserId),
      correlationId: envelope.correlationId ?? null,
      facts: factsFor(mapping, payload),
    };

    this.realtime.emitToConsole(mapping.permission, OPERATIONS_EVENT_CHANNEL, event);
  }

  /**
   * A `jobs.*` emit, observed on its way out of the gateway.
   *
   * The permission comes from the emit itself — it is the job's own
   * `requiredPermission` — so the console's copy is scoped exactly as the web
   * app's copy was, by construction rather than by a second table that could
   * disagree. A job with no required permission is scoped to `jobs.view` here
   * rather than to everyone: the web app's fallback is every authenticated
   * socket, which is wider than a console feed should be, and `jobs.view` is
   * what a console needs in order to have asked for jobs at all.
   */
  private onRealtimeEmit(event: string, payload: unknown, permission: string | null): void {
    if (!event.startsWith('jobs.')) return;
    if (!payload || typeof payload !== 'object') return;

    const job = payload as JobEventLike;
    const status = typeof job.status === 'string' ? job.status : 'updated';
    const jobId = typeof job.jobId === 'string' ? job.jobId : null;

    const operationsEvent: OperationsEvent = {
      /*
       * Job events carry no id of their own — the same job emits many — so one
       * is composed from the job, its status and the emit's own timestamp. That
       * makes a redelivery of the SAME transition dedupe on the client while two
       * genuine transitions stay distinct.
       */
      id: `job:${jobId ?? 'unknown'}:${status}:${typeof job.at === 'string' ? job.at : ''}`,
      at: typeof job.at === 'string' ? job.at : new Date().toISOString(),
      eventKey: event,
      category: 'job',
      severity: jobSeverity(status),
      summary: jobSummary(job),
      resourceType: 'platform_job',
      resourceId: jobId,
      // Platform jobs record no actor on the event; the Jobs Center owns that.
      actor: null,
      correlationId: typeof job.correlationId === 'string' ? job.correlationId : null,
      facts: this.jobFacts(job),
    };

    this.realtime.emitToConsole(
      permission ?? PERMISSIONS.JOBS_VIEW,
      OPERATIONS_EVENT_CHANNEL,
      operationsEvent,
    );
  }

  /**
   * Allowlisted job facts.
   *
   * `errorMessage` is deliberately absent: it is free text from whatever failed,
   * and the one place a connection string or a path with a credential in it
   * would plausibly appear. `errorCode` is the bounded, enumerable half, and it
   * is what a console filters on anyway.
   */
  private jobFacts(job: JobEventLike): Record<string, string | number | boolean> {
    const facts: Record<string, string | number | boolean> = {};
    if (typeof job.type === 'string') facts.type = job.type;
    if (typeof job.moduleKey === 'string') facts.moduleKey = job.moduleKey;
    if (typeof job.status === 'string') facts.status = job.status;
    if (typeof job.phase === 'string') facts.phase = job.phase;
    if (typeof job.progress === 'number' && Number.isFinite(job.progress)) {
      facts.progress = job.progress;
    }
    if (typeof job.errorCode === 'string') facts.errorCode = job.errorCode;
    return facts;
  }

  // -------------------------------------------------------------------------
  // Actors
  // -------------------------------------------------------------------------

  /**
   * The display name behind an actor id, cached.
   *
   * The contract carries a name and never an id, for a reason worth stating: a
   * user id is a handle to an account, and putting one in a stream that is
   * scoped by a domain permission hands every console reader a way to address
   * accounts they were never granted `users.view` over. A name is what the line
   * needs to be readable, and nothing more.
   *
   * A failed lookup caches null. An outage that made this throw per event would
   * otherwise put a query on the hot path for as long as it lasted.
   */
  private async actorName(userId: string | undefined): Promise<string | null> {
    if (!userId) return null;

    const now = Date.now();
    const cached = this.actorNames.get(userId);
    if (cached && cached.expiresAt > now) return cached.name;

    let name: string | null = null;
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { username: true, displayName: true },
      });
      name = user?.displayName || user?.username || null;
    } catch (err) {
      this.logger.warn(`Could not resolve actor ${userId}: ${(err as Error).message}`);
    }

    if (this.actorNames.size >= ACTOR_CACHE_MAX) {
      // Insertion-ordered, so this drops the least recently added.
      const oldest = this.actorNames.keys().next();
      if (!oldest.done) this.actorNames.delete(oldest.value);
    }
    this.actorNames.set(userId, { name, expiresAt: now + ACTOR_CACHE_TTL_MS });
    return name;
  }
}
