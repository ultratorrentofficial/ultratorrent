import { getDisplayTimezone } from '@/lib/format';
import {
  Activity, AlertTriangle, Clock, Download, Film, Gauge, HardDrive, Library,
  Monitor, Pause, Percent, Play, Plug, Server, Shield, Square, Tv, User, Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { PresentationAccent, PresentationIcon } from '@ultratorrent/shared';

/**
 * The one place semantic presentation values become visual ones.
 *
 * The model carries meanings (`accent: 'stopped'`, `icon: 'play'`); every colour
 * and glyph resolves through these tables. A component reaching for its own red
 * would be a second source of truth the moment the palette changed.
 */
export const PRESENTATION_ICONS: Record<PresentationIcon, LucideIcon> = {
  play: Play, stop: Square, pause: Pause, buffering: Activity,
  download: Download, alert: AlertTriangle, disk: HardDrive,
  workflow: Workflow, plug: Plug, shield: Shield, user: User,
  film: Film, tv: Tv, clock: Clock, percent: Percent,
  monitor: Monitor, activity: Activity, library: Library,
  server: Server, gauge: Gauge,
};

export interface AccentTokens {
  border: string;
  rail: string;
  glow: string;
  text: string;
  ring: string;
  button: string;
  bar: string;
}

/**
 * Accent → Tailwind classes.
 *
 * Written as complete class strings rather than interpolated fragments
 * (`border-${c}-500/40`): Tailwind's scanner only sees literals, so a
 * constructed name is dropped from the bundle and renders unstyled in
 * production while looking fine in dev.
 *
 * `stopped` is coral rather than the error red — playback ending is not a
 * failure, and reusing the error colour would say it was.
 */
export const ACCENT_TOKENS: Record<PresentationAccent, AccentTokens> = {
  started: {
    border: 'border-emerald-500/40', rail: 'bg-emerald-500', glow: 'from-emerald-500/10',
    text: 'text-emerald-400', ring: 'ring-emerald-500/60',
    button: 'hover:border-emerald-500/50 hover:bg-emerald-500/10 hover:text-emerald-300',
    bar: 'bg-emerald-500',
  },
  stopped: {
    border: 'border-rose-500/40', rail: 'bg-rose-500', glow: 'from-rose-500/10',
    text: 'text-rose-400', ring: 'ring-rose-500/60',
    button: 'hover:border-rose-500/50 hover:bg-rose-500/10 hover:text-rose-300',
    bar: 'bg-rose-500',
  },
  success: {
    border: 'border-emerald-500/40', rail: 'bg-emerald-500', glow: 'from-emerald-500/10',
    text: 'text-emerald-400', ring: 'ring-emerald-500/60',
    button: 'hover:border-emerald-500/50 hover:bg-emerald-500/10 hover:text-emerald-300',
    bar: 'bg-emerald-500',
  },
  warning: {
    border: 'border-amber-500/40', rail: 'bg-amber-500', glow: 'from-amber-500/10',
    text: 'text-amber-400', ring: 'ring-amber-500/60',
    button: 'hover:border-amber-500/50 hover:bg-amber-500/10 hover:text-amber-300',
    bar: 'bg-amber-500',
  },
  error: {
    border: 'border-red-600/50', rail: 'bg-red-600', glow: 'from-red-600/10',
    text: 'text-red-400', ring: 'ring-red-600/60',
    button: 'hover:border-red-600/50 hover:bg-red-600/10 hover:text-red-300',
    bar: 'bg-red-600',
  },
  neutral: {
    border: 'border-white/10', rail: 'bg-white/30', glow: 'from-white/5',
    text: 'text-muted-foreground', ring: 'ring-white/20',
    button: 'hover:border-white/20 hover:bg-white/5',
    bar: 'bg-white/40',
  },
};

/** Playback state → accent + icon, shared by the card and the live dashboard. */
export function accentForPlaybackState(state: string | null | undefined): {
  accent: PresentationAccent;
  icon: PresentationIcon;
} {
  switch ((state ?? '').toLowerCase()) {
    case 'paused':
      return { accent: 'warning', icon: 'pause' };
    case 'buffering':
      return { accent: 'warning', icon: 'buffering' };
    case 'stopped':
      return { accent: 'stopped', icon: 'stop' };
    default:
      return { accent: 'started', icon: 'play' };
  }
}

/**
 * A compact relative time — "now", "2m ago", "3h ago", then a date.
 *
 * Not `Intl.RelativeTimeFormat`: this must pick the unit as well as format it,
 * and past a day the actual date is more useful than "2 days ago".
 */
export function relativeTime(iso: string, locale: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  // Clock skew between server and browser must not produce "in -3 seconds".
  if (seconds < 45) return locale.startsWith('es') ? 'ahora' : 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return locale.startsWith('es') ? `hace ${minutes} min` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return locale.startsWith('es') ? `hace ${hours} h` : `${hours}h ago`;
  // Zone-aware: past the relative window this renders an absolute date, which
  // must follow the user's chosen zone like every other absolute time.
  try {
    return new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      timeZone: getDisplayTimezone() ?? undefined,
    }).format(then);
  } catch {
    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(then);
  }
}
