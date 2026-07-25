import type { NotificationEventDefinition } from '../catalog/notification-catalog.types';

export interface RenderedMessage {
  subject: string;
  text: string;
}

/** Supported recipient locales. Anything else falls back to en-US. */
type Locale = 'en-US' | 'es-PR';

/**
 * Human titles for events whose generated name would be poor.
 *
 * Deliberately NOT a table of all 69 events in two languages. Most event keys
 * humanize perfectly well (`download.torrent_completed` → "Torrent completed"), and
 * 138 hand-written strings would rot the moment the catalogue changed — a missing
 * one silently reverting to a raw key is exactly the bug this replaces. Only entries
 * the humanizer gets *wrong* are listed, so the table stays small and true.
 */
const TITLE_OVERRIDES: Record<string, Record<Locale, string>> = {
  'system.disk_space_low': { 'en-US': 'Low disk space', 'es-PR': 'Poco espacio en disco' },
  'system.cpu_high': { 'en-US': 'High CPU usage', 'es-PR': 'Uso alto de CPU' },
  'system.memory_high': { 'en-US': 'High memory usage', 'es-PR': 'Uso alto de memoria' },
  'system.api_key_created': { 'en-US': 'API key created', 'es-PR': 'Clave de API creada' },
  'system.new_login': { 'en-US': 'New sign-in to your account', 'es-PR': 'Nuevo inicio de sesión en tu cuenta' },
  'system.failed_login': { 'en-US': 'Failed sign-in attempt', 'es-PR': 'Intento de inicio de sesión fallido' },
  'system.security_alert': { 'en-US': 'Security alert', 'es-PR': 'Alerta de seguridad' },
  'media_server.user_started_watching': { 'en-US': 'Playback started', 'es-PR': 'Reproducción iniciada' },
  'media_server.user_finished_watching': { 'en-US': 'Playback finished', 'es-PR': 'Reproducción finalizada' },
  'media_server.high_bandwidth': { 'en-US': 'High bandwidth usage', 'es-PR': 'Uso alto de ancho de banda' },
  'workflow.execution.failed': { 'en-US': 'Workflow run failed', 'es-PR': 'La ejecución del flujo falló' },
  'workflow.execution.completed': { 'en-US': 'Workflow run completed', 'es-PR': 'Ejecución del flujo completada' },
  'workflow.approval.requested': { 'en-US': 'Approval requested', 'es-PR': 'Aprobación solicitada' },
  'library_cleanup.plan.pending_approval': { 'en-US': 'Cleanup plan needs approval', 'es-PR': 'El plan de limpieza necesita aprobación' },
};

const SEVERITY_PREFIX: Record<string, Record<Locale, string>> = {
  critical: { 'en-US': 'Critical', 'es-PR': 'Crítico' },
  security: { 'en-US': 'Security', 'es-PR': 'Seguridad' },
  error: { 'en-US': 'Error', 'es-PR': 'Error' },
};

/**
 * `download.torrent_completed` → `Torrent completed`.
 *
 * Drops the namespace (the recipient already knows which product this is), splits on
 * underscores, and sentence-cases. The point is that an event added tomorrow with no
 * translation still renders as readable English rather than a key.
 */
export function humanizeEventKey(key: string): string {
  const last = key.split('.').slice(1).join(' ') || key;
  const words = last.replace(/[._]+/g, ' ').trim();
  if (!words) return key;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function localeOf(raw: string | null | undefined): Locale {
  return raw === 'es-PR' ? 'es-PR' : 'en-US';
}

/** Payload fields worth showing, in the order a reader wants them. */
const DETAIL_FIELDS = [
  'mediaTitle', 'title', 'name', 'episodeTitle', 'seriesTitle',
  'userDisplayName', 'libraryName', 'serverName',
  'path', 'reason', 'message', 'error',
];

/** Values a reader should never see verbatim in a message body. */
const REDACTED_FIELDS = ['token', 'secret', 'password', 'apiKey', 'webhookUrl', 'chatId'];

function isRenderable(value: unknown): boolean {
  return (
    (typeof value === 'string' && value.trim() !== '') ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/**
 * Render one notification for one recipient.
 *
 * Replaces sending the raw i18n key, which is what external channels did before this:
 * a delivered Telegram message read `events.download.torrent_completed.title`.
 *
 * The body is assembled from the payload rather than a per-event template, because 69
 * templates in two languages is a maintenance burden that fails silently — a missing
 * template renders nothing, and nobody notices until a channel goes quiet. Field
 * selection is an allow-list, so a payload gaining a secret field cannot leak it into
 * a message, and known credential-ish names are dropped even if allow-listed.
 */
export function renderNotificationMessage(
  definition: NotificationEventDefinition,
  payload: Record<string, unknown>,
  recipientLocale?: string | null,
): RenderedMessage {
  const locale = localeOf(recipientLocale);
  const title = TITLE_OVERRIDES[definition.key]?.[locale] ?? humanizeEventKey(definition.key);

  // Severity leads the subject only when it changes what the reader should do.
  const prefix = SEVERITY_PREFIX[definition.severity]?.[locale];
  const subject = prefix ? `[${prefix}] ${title}` : title;

  const body = (payload ?? {}) as Record<string, unknown>;
  const lines: string[] = [];
  for (const field of DETAIL_FIELDS) {
    if (REDACTED_FIELDS.includes(field)) continue;
    const value = body[field];
    if (!isRenderable(value)) continue;
    const text = String(value).trim();
    if (!text || lines.includes(text)) continue; // skip duplicates (title vs mediaTitle)
    lines.push(text);
    if (lines.length >= 4) break; // a notification is a nudge, not a report
  }

  const text = lines.length ? `${subject}\n\n${lines.join('\n')}` : subject;
  return { subject, text };
}
