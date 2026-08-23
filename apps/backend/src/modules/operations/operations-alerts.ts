import type {
  OperationsAlert,
  OperationsDomainKey,
  OperationsEngine,
  OperationsIndexer,
  OperationsJobs,
  OperationsMediaIntake,
  OperationsProvider,
  OperationsSeverity,
  OperationsStorage,
  OperationsSystem,
  OperationsTorrents,
} from '@ultratorrent/shared';

/**
 * The attention model — a **projection**, not a store.
 *
 * Every alert below is derived, at snapshot time, from state some other
 * subsystem already owns: an engine's last poll, a storage root's free bytes, a
 * job's status, an intake job's failure. Nothing here is persisted, nothing can
 * be acknowledged, and nothing survives the condition that produced it. That is
 * deliberate: an acknowledgeable alert is a piece of mutable server state, and
 * this platform's console is not allowed to mutate server state — so an alert
 * store would be a feature only the web app could ever finish.
 *
 * The consequence to be honest about: an alert cannot be silenced. The way to
 * make one go away is to fix what it is reporting.
 *
 * Pure by construction — no Prisma, no clock beyond the `now` handed in, no
 * service dependencies — so the thresholds can be tested without a database.
 */

/** Free-space thresholds, as a fraction used. */
export const STORAGE_WARNING_AT = 0.9;
export const STORAGE_CRITICAL_AT = 0.97;

/** Load average per core above which the backend host is called saturated. */
export const LOAD_WARNING_PER_CORE = 1.5;
export const LOAD_CRITICAL_PER_CORE = 4;

/**
 * A stable id for a condition.
 *
 * Stable so a console can tell "still the same engine still down" from "a
 * second engine just went down" and avoid re-announcing the first. It is
 * derived from the condition, not stored, and therefore means nothing to the
 * server — it is not a handle anything can be done to.
 */
function alertId(domain: OperationsDomainKey, kind: string, subject?: string): string {
  return subject ? `${domain}:${kind}:${subject}` : `${domain}:${kind}`;
}

function alert(
  domain: OperationsDomainKey,
  kind: string,
  severity: OperationsSeverity,
  title: string,
  detail: string | null,
  since: string | null,
  subject?: string,
): OperationsAlert {
  return { id: alertId(domain, kind, subject), severity, domain, title, detail, since };
}

export interface AlertInputs {
  system?: OperationsSystem;
  storage?: OperationsStorage;
  torrents?: OperationsTorrents;
  mediaIntake?: OperationsMediaIntake;
  jobs?: OperationsJobs;
  engines?: OperationsEngine[];
  indexers?: OperationsIndexer[];
  providers?: OperationsProvider[];
}

/**
 * Project the collected domains into an ordered attention list.
 *
 * Only domains the caller was actually permitted to read are passed in, so a
 * user who cannot see torrents never learns from an alert that an engine is
 * down. This is why alerts are computed **after** permission filtering rather
 * than from a privileged view of the world.
 */
export function projectAlerts(input: AlertInputs): OperationsAlert[] {
  const out: OperationsAlert[] = [];

  for (const engine of input.engines ?? []) {
    if (engine.health === 'down') {
      out.push(
        alert(
          'engines',
          'engine_offline',
          'critical',
          `Torrent engine ${engine.engineId} is offline`,
          engine.error,
          engine.lastSeenAt,
          engine.engineId,
        ),
      );
    } else if (engine.health === 'unknown') {
      out.push(
        alert(
          'engines',
          'engine_unknown',
          'warning',
          `Torrent engine ${engine.engineId} has not been reached since startup`,
          null,
          null,
          engine.engineId,
        ),
      );
    }
  }

  for (const root of input.storage?.roots ?? []) {
    if (root.usedPercent === null) {
      out.push(
        alert('storage', 'root_unreadable', 'warning', `Storage root ${root.path} could not be measured`, root.error ?? null, null, root.path),
      );
      continue;
    }
    const used = root.usedPercent / 100;
    if (used >= STORAGE_CRITICAL_AT) {
      out.push(
        alert('storage', 'root_full', 'critical', `Storage ${root.path} is ${root.usedPercent}% full`, 'Writes will begin to fail.', null, root.path),
      );
    } else if (used >= STORAGE_WARNING_AT) {
      out.push(
        alert('storage', 'root_filling', 'warning', `Storage ${root.path} is ${root.usedPercent}% full`, null, null, root.path),
      );
    }
  }

  if (input.system) {
    if (input.system.database !== 'healthy') {
      out.push(alert('system', 'database', 'critical', 'The database is not answering', null, null));
    }
    const perCore = input.system.cpuCount > 0 ? input.system.loadAverage[0] / input.system.cpuCount : 0;
    if (perCore >= LOAD_CRITICAL_PER_CORE) {
      out.push(
        alert('system', 'load', 'error', `Backend host load is ${input.system.loadAverage[0].toFixed(2)} across ${input.system.cpuCount} cores`, null, null),
      );
    } else if (perCore >= LOAD_WARNING_PER_CORE) {
      out.push(
        alert('system', 'load', 'warning', `Backend host load is ${input.system.loadAverage[0].toFixed(2)} across ${input.system.cpuCount} cores`, null, null),
      );
    }
  }

  if (input.mediaIntake) {
    if (input.mediaIntake.failed > 0) {
      out.push(
        alert('mediaIntake', 'failed', 'error', `${input.mediaIntake.failed} media intake job(s) failed`, 'Imports are not completing.', null),
      );
    }
    if (input.mediaIntake.quarantined > 0) {
      out.push(
        alert('mediaIntake', 'quarantined', 'warning', `${input.mediaIntake.quarantined} media intake job(s) are quarantined`, 'They need an operator decision in the web app.', null),
      );
    }
  }

  /*
   * Alert on TODAY's failures, not the all-time count.
   *
   * `failed` is every failed job ever and never decreases, so an alert on it
   * can never clear: red from the first failure onwards, which teaches an
   * operator to skip it — worse than not raising it at all. Live this read 13
   * while every one of those jobs was three weeks old and eleven were only
   * "Interrupted by a service restart": jobs killed mid-flight by a deploy,
   * which every deploy manufactures more of.
   *
   * The all-time figure stays in the jobs domain for the pane to show, and is
   * carried as the alert's detail. It is a statistic, not an event, and only
   * events deserve an alert.
   */
  if (input.jobs && input.jobs.failedToday > 0) {
    out.push(
      alert('jobs', 'failed', 'error', `${input.jobs.failedToday} background job(s) failed today`, `${input.jobs.failed} have failed in total.`, null),
    );
  }

  if (input.torrents) {
    if (input.torrents.counts.errored > 0) {
      out.push(alert('torrents', 'errored', 'error', `${input.torrents.counts.errored} torrent(s) are in an error state`, null, null));
    }
    if (input.torrents.counts.stalled > 0) {
      out.push(
        alert('torrents', 'stalled', 'warning', `${input.torrents.counts.stalled} download(s) are stalled`, 'Downloading with no peers and no throughput.', null),
      );
    }
  }

  for (const indexer of input.indexers ?? []) {
    if (indexer.enabled && indexer.health === 'down') {
      out.push(
        alert('indexers', 'indexer_error', 'warning', `Indexer ${indexer.name} last tested as failing`, indexer.message, indexer.lastTestedAt, indexer.id),
      );
    }
  }

  for (const provider of input.providers ?? []) {
    if (provider.enabled && provider.health === 'down') {
      out.push(
        alert(
          'providers',
          'provider_down',
          provider.category === 'media_server' ? 'error' : 'warning',
          `${provider.name} is unreachable`,
          provider.message,
          provider.lastCheckedAt,
          `${provider.category}:${provider.key}`,
        ),
      );
    }
  }

  return sortAlerts(out);
}

const SEVERITY_ORDER: Record<OperationsSeverity, number> = {
  critical: 0,
  error: 1,
  warning: 2,
  info: 3,
};

/** Most severe first; ties broken by id so the order is stable between snapshots. */
export function sortAlerts(alerts: OperationsAlert[]): OperationsAlert[] {
  return [...alerts].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.id.localeCompare(b.id),
  );
}
