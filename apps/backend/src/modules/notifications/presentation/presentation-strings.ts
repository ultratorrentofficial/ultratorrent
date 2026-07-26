/**
 * Presentation copy, in code beside the builders that use it.
 *
 * Not in the frontend i18n bundles: a presentation is built on the server, per
 * recipient, and stored — email and Telegram have no browser to ask i18next.
 * Keeping the copy here also means a new event ships its strings in the same
 * commit rather than rendering a raw key until someone remembers the JSON.
 *
 * Both locales are required by the type, so adding a string without its Spanish
 * translation fails the build instead of silently falling back to English.
 */
export type PresentationLocale = 'en-US' | 'es-PR';
type Copy = Record<PresentationLocale, string>;

export const STRINGS = {
  // --- playback -------------------------------------------------------------
  startedLead: { 'en-US': 'User Started', 'es-PR': 'Usuario comenzó' } satisfies Copy,
  startedTrail: { 'en-US': 'Watching', 'es-PR': 'a ver' } satisfies Copy,
  stoppedLead: { 'en-US': 'User Stopped', 'es-PR': 'Usuario detuvo' } satisfies Copy,
  stoppedTrail: { 'en-US': 'Watching', 'es-PR': 'la reproducción' } satisfies Copy,
  startedSummary: {
    'en-US': '{name} started watching {media}',
    'es-PR': '{name} comenzó a ver {media}',
  } satisfies Copy,
  stoppedSummary: {
    'en-US': '{name} stopped watching {media}',
    'es-PR': '{name} dejó de ver {media}',
  } satisfies Copy,

  /*
   * Natural-language playback phrases.
   *
   * Whole clauses, not fragments assembled at render time: Spanish puts the verb
   * and preposition together ("comenzó a ver"), so concatenating a verb with a
   * separate "to" produces grammatical nonsense in one language while looking
   * fine in the other. `{name}` is the only substitution.
   *
   * These replace the old two-tone headline for compact surfaces. "User Started
   * Watching" is an event label; a person reads "Dennis started watching".
   */
  startedWatchingPhrase: {
    'en-US': '{name} started watching',
    'es-PR': '{name} comenzó a ver',
  } satisfies Copy,
  resumedWatchingPhrase: {
    'en-US': '{name} resumed watching',
    'es-PR': '{name} continuó viendo',
  } satisfies Copy,
  startedListeningPhrase: {
    'en-US': '{name} started listening to',
    'es-PR': '{name} comenzó a escuchar',
  } satisfies Copy,
  resumedListeningPhrase: {
    'en-US': '{name} resumed listening to',
    'es-PR': '{name} continuó escuchando',
  } satisfies Copy,
  /** Stands in for a name the recipient may not see. Reads as a clause subject. */
  aUser: { 'en-US': 'A user', 'es-PR': 'Un usuario' } satisfies Copy,
  resumedAt: { 'en-US': 'Resumed at {percent}%', 'es-PR': 'Retomado al {percent}%' } satisfies Copy,

  nowPlaying: { 'en-US': 'Now Playing', 'es-PR': 'Reproduciendo ahora' } satisfies Copy,
  paused: { 'en-US': 'Paused', 'es-PR': 'En pausa' } satisfies Copy,
  buffering: { 'en-US': 'Buffering', 'es-PR': 'Almacenando en búfer' } satisfies Copy,
  percentWatched: { 'en-US': '{percent}% watched', 'es-PR': '{percent}% visto' } satisfies Copy,
  watchedFor: { 'en-US': 'Watched for {duration}', 'es-PR': 'Vio durante {duration}' } satisfies Copy,

  // --- downloads ------------------------------------------------------------
  downloadCompleteLead: { 'en-US': 'Download', 'es-PR': 'Descarga' } satisfies Copy,
  downloadCompleteTrail: { 'en-US': 'Complete', 'es-PR': 'completada' } satisfies Copy,
  downloadFailedLead: { 'en-US': 'Download', 'es-PR': 'Descarga' } satisfies Copy,
  downloadFailedTrail: { 'en-US': 'Failed', 'es-PR': 'fallida' } satisfies Copy,
  torrentCompletedSummary: { 'en-US': '{name} finished downloading', 'es-PR': '{name} terminó de descargarse' } satisfies Copy,
  torrentFailedSummary: { 'en-US': '{name} could not be downloaded', 'es-PR': 'No se pudo descargar {name}' } satisfies Copy,

  // --- storage --------------------------------------------------------------
  storageLead: { 'en-US': 'Storage', 'es-PR': 'Almacenamiento' } satisfies Copy,
  storageWarningTrail: { 'en-US': 'Running Low', 'es-PR': 'casi lleno' } satisfies Copy,
  storageCriticalTrail: { 'en-US': 'Critical', 'es-PR': 'crítico' } satisfies Copy,
  storageRecoveredTrail: { 'en-US': 'Recovered', 'es-PR': 'recuperado' } satisfies Copy,
  storageSummary: { 'en-US': '{path} has {percent}% free', 'es-PR': '{path} tiene {percent}% libre' } satisfies Copy,

  // --- workflows ------------------------------------------------------------
  workflowLead: { 'en-US': 'Workflow', 'es-PR': 'Flujo de trabajo' } satisfies Copy,
  workflowApprovalTrail: { 'en-US': 'Needs Approval', 'es-PR': 'necesita aprobación' } satisfies Copy,
  workflowFailedTrail: { 'en-US': 'Failed', 'es-PR': 'fallido' } satisfies Copy,
  workflowCompletedTrail: { 'en-US': 'Completed', 'es-PR': 'completado' } satisfies Copy,
  workflowApprovalSummary: { 'en-US': '{name} is waiting for a decision', 'es-PR': '{name} espera una decisión' } satisfies Copy,
  workflowFailedSummary: { 'en-US': '{name} failed to run', 'es-PR': '{name} falló al ejecutarse' } satisfies Copy,
  workflowCompletedSummary: { 'en-US': '{name} finished successfully', 'es-PR': '{name} terminó con éxito' } satisfies Copy,

  // --- providers ------------------------------------------------------------
  providerLead: { 'en-US': 'Provider', 'es-PR': 'Proveedor' } satisfies Copy,
  providerOfflineTrail: { 'en-US': 'Offline', 'es-PR': 'sin conexión' } satisfies Copy,
  providerRecoveredTrail: { 'en-US': 'Recovered', 'es-PR': 'recuperado' } satisfies Copy,
  refreshFailedTrail: { 'en-US': 'Refresh Failed', 'es-PR': 'actualización fallida' } satisfies Copy,
  providerOfflineSummary: { 'en-US': '{name} stopped responding', 'es-PR': '{name} dejó de responder' } satisfies Copy,
  providerRecoveredSummary: { 'en-US': '{name} is responding again', 'es-PR': '{name} responde de nuevo' } satisfies Copy,
  refreshFailedSummary: { 'en-US': '{name} could not refresh its library', 'es-PR': '{name} no pudo actualizar su biblioteca' } satisfies Copy,

  // --- security / users -----------------------------------------------------
  securityLead: { 'en-US': 'Security', 'es-PR': 'Seguridad' } satisfies Copy,
  passwordChangedTrail: { 'en-US': 'Password Changed', 'es-PR': 'contraseña cambiada' } satisfies Copy,
  twoFactorDisabledTrail: { 'en-US': 'Two-Factor Disabled', 'es-PR': 'doble factor desactivado' } satisfies Copy,
  apiKeyCreatedTrail: { 'en-US': 'API Key Created', 'es-PR': 'clave de API creada' } satisfies Copy,
  loginFailedTrail: { 'en-US': 'Sign-In Failed', 'es-PR': 'inicio de sesión fallido' } satisfies Copy,
  passwordChangedSummary: { 'en-US': 'Your account password was changed', 'es-PR': 'La contraseña de tu cuenta fue cambiada' } satisfies Copy,
  twoFactorDisabledSummary: { 'en-US': 'Two-factor authentication was turned off', 'es-PR': 'La autenticación de doble factor fue desactivada' } satisfies Copy,
  apiKeyCreatedSummary: { 'en-US': 'A new API key "{name}" was issued', 'es-PR': 'Se emitió una nueva clave de API "{name}"' } satisfies Copy,
  loginFailedSummary: { 'en-US': 'A sign-in attempt for {name} failed', 'es-PR': 'Falló un intento de inicio de sesión para {name}' } satisfies Copy,
  userLead: { 'en-US': 'User', 'es-PR': 'Usuario' } satisfies Copy,
  userCreatedTrail: { 'en-US': 'Created', 'es-PR': 'creado' } satisfies Copy,
  userRoleChangedTrail: { 'en-US': 'Roles Changed', 'es-PR': 'roles cambiados' } satisfies Copy,
  userCreatedSummary: { 'en-US': 'Account {name} was created', 'es-PR': 'Se creó la cuenta {name}' } satisfies Copy,
  userRoleChangedSummary: { 'en-US': "Roles for {name} were changed", 'es-PR': 'Se cambiaron los roles de {name}' } satisfies Copy,

  // --- fact labels ----------------------------------------------------------
  fieldUser: { 'en-US': 'User', 'es-PR': 'Usuario' } satisfies Copy,
  fieldMedia: { 'en-US': 'Media', 'es-PR': 'Contenido' } satisfies Copy,
  fieldEpisode: { 'en-US': 'Episode', 'es-PR': 'Episodio' } satisfies Copy,
  fieldTime: { 'en-US': 'Time', 'es-PR': 'Hora' } satisfies Copy,
  fieldProgress: { 'en-US': 'Progress', 'es-PR': 'Progreso' } satisfies Copy,
  fieldPlayer: { 'en-US': 'Player', 'es-PR': 'Reproductor' } satisfies Copy,
  fieldQuality: { 'en-US': 'Quality', 'es-PR': 'Calidad' } satisfies Copy,
  fieldServer: { 'en-US': 'Server', 'es-PR': 'Servidor' } satisfies Copy,
  fieldLibrary: { 'en-US': 'Library', 'es-PR': 'Biblioteca' } satisfies Copy,
  fieldSize: { 'en-US': 'Size', 'es-PR': 'Tamaño' } satisfies Copy,
  fieldReason: { 'en-US': 'Reason', 'es-PR': 'Motivo' } satisfies Copy,
  fieldLocation: { 'en-US': 'Location', 'es-PR': 'Ubicación' } satisfies Copy,
  fieldFree: { 'en-US': 'Free space', 'es-PR': 'Espacio libre' } satisfies Copy,
  fieldWorkflow: { 'en-US': 'Workflow', 'es-PR': 'Flujo' } satisfies Copy,
  fieldAccount: { 'en-US': 'Account', 'es-PR': 'Cuenta' } satisfies Copy,

  // --- actions --------------------------------------------------------------
  viewDetails: { 'en-US': 'View details', 'es-PR': 'Ver detalles' } satisfies Copy,
  viewActivity: { 'en-US': 'View activity', 'es-PR': 'Ver actividad' } satisfies Copy,
  viewTorrents: { 'en-US': 'View downloads', 'es-PR': 'Ver descargas' } satisfies Copy,
  viewStorage: { 'en-US': 'View storage', 'es-PR': 'Ver almacenamiento' } satisfies Copy,
  reviewWorkflow: { 'en-US': 'Review workflow', 'es-PR': 'Revisar flujo' } satisfies Copy,
  viewProviders: { 'en-US': 'View providers', 'es-PR': 'Ver proveedores' } satisfies Copy,
  reviewAccount: { 'en-US': 'Review account', 'es-PR': 'Revisar cuenta' } satisfies Copy,
  viewUsers: { 'en-US': 'View users', 'es-PR': 'Ver usuarios' } satisfies Copy,
  viewLiveActivity: { 'en-US': 'View Live Activity', 'es-PR': 'Ver actividad en vivo' } satisfies Copy,

  // --- misc -----------------------------------------------------------------
  posterAlt: { 'en-US': 'Poster for {title}', 'es-PR': 'Póster de {title}' } satisfies Copy,
  someone: { 'en-US': 'Someone', 'es-PR': 'Alguien' } satisfies Copy,
  today: { 'en-US': 'Today', 'es-PR': 'Hoy' } satisfies Copy,
} as const;

export type StringKey = keyof typeof STRINGS;

/** Look up a string and substitute `{placeholders}`. */
export function s(
  key: StringKey,
  locale: PresentationLocale,
  vars: Record<string, string | number> = {},
): string {
  return STRINGS[key][locale].replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/**
 * "Today, 8:24 PM" or "Jul 24, 8:24 PM", in the recipient's zone.
 *
 * "Today" is decided by comparing the *rendered* calendar date, not by
 * subtracting timestamps: a 24-hour arithmetic window gets it wrong twice a day
 * for anyone whose offset pushes an event across midnight.
 *
 * An invalid stored zone falls back to the server's rather than throwing —
 * `Intl` rejects a bad `timeZone`, and a stored preference must not break a render.
 */
export function formatWhen(
  iso: string,
  locale: PresentationLocale,
  timezone: string | null,
  now: Date = new Date(),
): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '';

  const dateOpts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' };
  const timeOpts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

  let dateFmt: Intl.DateTimeFormat;
  let timeFmt: Intl.DateTimeFormat;
  try {
    const tz = timezone ?? undefined;
    dateFmt = new Intl.DateTimeFormat(locale, { ...dateOpts, timeZone: tz });
    timeFmt = new Intl.DateTimeFormat(locale, { ...timeOpts, timeZone: tz });
  } catch {
    dateFmt = new Intl.DateTimeFormat(locale, dateOpts);
    timeFmt = new Intl.DateTimeFormat(locale, timeOpts);
  }

  const time = timeFmt.format(when);
  const day = dateFmt.format(when);
  return day === dateFmt.format(now) ? `${s('today', locale)}, ${time}` : `${day}, ${time}`;
}
