import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DOMAIN_EVENTS, DOMAIN_EVENT_CHANNEL, type DomainEventEnvelope } from '@ultratorrent/shared';
import { MediaRelocationService } from './media-relocation.service';

/**
 * Keeps media records in step with whatever moved the bytes.
 *
 * The file manager, the trash and any future mover cannot call into the media
 * module — media already depends on files, so a direct call would close a
 * cycle. They publish a fact instead, and this follows it.
 *
 * That inversion is the point. Before it, staying consistent meant every author
 * of a file operation remembering to update five tables; the rename engine
 * forgot for as long as it has existed, and the file manager never did it at
 * all. A subsystem now only has to say what it did.
 */
@Injectable()
export class FileEventBridge {
  private readonly logger = new Logger(FileEventBridge.name);

  constructor(private readonly relocation: MediaRelocationService) {}

  @OnEvent(DOMAIN_EVENT_CHANNEL)
  async handle(envelope: DomainEventEnvelope): Promise<void> {
    try {
      const payload = (envelope.payload ?? {}) as Record<string, unknown>;

      if (envelope.eventKey === DOMAIN_EVENTS.FILE_MOVED) {
        const from = typeof payload.from === 'string' ? payload.from : null;
        const to = typeof payload.to === 'string' ? payload.to : null;
        if (from && to) await this.relocation.recordMove(from, to);
        return;
      }

      if (envelope.eventKey === DOMAIN_EVENTS.FILE_DELETED) {
        const path = typeof payload.path === 'string' ? payload.path : null;
        // Sidecar rows only — deleting the MediaItem here would cascade its
        // metadata and artwork away on a file-manager delete, and the scanner
        // already prunes an item whose video is genuinely gone.
        if (path) await this.relocation.recordDelete(path);
        return;
      }
    } catch (err) {
      // A subscriber must never throw at the bus: the file operation already
      // happened, and failing here would neither undo it nor help the caller.
      this.logger.error(`File-event bookkeeping failed: ${(err as Error).message}`);
    }
  }
}
