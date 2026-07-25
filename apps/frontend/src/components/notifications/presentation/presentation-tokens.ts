import {
  Activity, AlertTriangle, Clock, Film, Library, Monitor, Pause, Percent,
  Play, Server, Square, Tv, User, type LucideIcon,
} from 'lucide-react';
import type { PresentationAccent, PresentationIcon } from '@ultratorrent/shared';

/**
 * The one place semantic presentation values become visual ones.
 *
 * The presentation model carries meanings (`accent: 'negative'`, `icon: 'stop'`);
 * every colour and glyph in the rich card resolves through these two tables. A
 * component that reached for its own red would be a second source of truth the
 * moment the palette changed.
 */

/** Icon names → components. Named icons keep glyph choice out of the backend. */
export const PRESENTATION_ICONS: Record<PresentationIcon, LucideIcon> = {
  play: Play,
  stop: Square,
  pause: Pause,
  user: User,
  film: Film,
  tv: Tv,
  clock: Clock,
  percent: Percent,
  monitor: Monitor,
  activity: Activity,
  library: Library,
  server: Server,
  alert: AlertTriangle,
};

export interface AccentTokens {
  /** Card border. */
  border: string;
  /** The vertical bar down the card's leading edge. */
  rail: string;
  /** Ambient wash behind the card. */
  glow: string;
  /** Headline lead, state icon, fact icons. */
  text: string;
  /** Avatar ring. */
  ring: string;
  /** Primary action button. */
  button: string;
  /** Progress bar fill. */
  bar: string;
}

/**
 * Accent → Tailwind classes, for light and dark alike.
 *
 * Written as complete class strings rather than interpolated fragments
 * (`border-${color}-500/40`) because Tailwind's scanner only sees literals — a
 * constructed name is silently dropped from the bundle and the card renders
 * unstyled in production while looking fine in dev.
 */
export const ACCENT_TOKENS: Record<PresentationAccent, AccentTokens> = {
  positive: {
    border: 'border-emerald-500/40',
    rail: 'bg-emerald-500',
    glow: 'from-emerald-500/10',
    text: 'text-emerald-400',
    ring: 'ring-emerald-500/60',
    button: 'hover:border-emerald-500/50 hover:bg-emerald-500/10 hover:text-emerald-300',
    bar: 'bg-emerald-500',
  },
  negative: {
    border: 'border-red-500/40',
    rail: 'bg-red-500',
    glow: 'from-red-500/10',
    text: 'text-red-400',
    ring: 'ring-red-500/60',
    button: 'hover:border-red-500/50 hover:bg-red-500/10 hover:text-red-300',
    bar: 'bg-red-500',
  },
  warning: {
    border: 'border-amber-500/40',
    rail: 'bg-amber-500',
    glow: 'from-amber-500/10',
    text: 'text-amber-400',
    ring: 'ring-amber-500/60',
    button: 'hover:border-amber-500/50 hover:bg-amber-500/10 hover:text-amber-300',
    bar: 'bg-amber-500',
  },
  critical: {
    border: 'border-rose-600/50',
    rail: 'bg-rose-600',
    glow: 'from-rose-600/10',
    text: 'text-rose-400',
    ring: 'ring-rose-600/60',
    button: 'hover:border-rose-600/50 hover:bg-rose-600/10 hover:text-rose-300',
    bar: 'bg-rose-600',
  },
  neutral: {
    border: 'border-white/10',
    rail: 'bg-white/30',
    glow: 'from-white/5',
    text: 'text-muted-foreground',
    ring: 'ring-white/20',
    button: 'hover:border-white/20 hover:bg-white/5',
    bar: 'bg-white/40',
  },
};

/**
 * A compact relative time — "now", "2m ago", "3h ago", then a date.
 *
 * Deliberately not `Intl.RelativeTimeFormat`: this needs to pick the unit as well
 * as format it, and beyond a day "2 days ago" is less useful on a notification
 * than the actual date.
 */
export function relativeTime(iso: string, locale: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  // A clock skew between server and browser must not produce "in -3 seconds".
  if (seconds < 45) return locale.startsWith('es') ? 'ahora' : 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return locale.startsWith('es') ? `hace ${minutes} min` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return locale.startsWith('es') ? `hace ${hours} h` : `${hours}h ago`;
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(then);
}
