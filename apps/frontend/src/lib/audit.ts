/**
 * Turns raw audit rows (machine codes like `file.deleted` + metadata) into
 * human-readable descriptions: a friendly sentence, an icon, a category, and a
 * tone for colour. Pure + presentation-only; the raw `action` is always kept so
 * power users can still see the underlying code.
 */
import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  AlertTriangle,
  Ban,
  Boxes,
  Copy,
  Download,
  FilePen,
  FolderInput,
  FolderPlus,
  KeyRound,
  ListChecks,
  Lock,
  LogIn,
  LogOut,
  Film,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ServerCog,
  Settings,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Square,
  Trash2,
  Users,
} from 'lucide-react';
import type { AuditEntry } from './api';
import { formatBytes } from './format';

export type AuditTone = 'neutral' | 'positive' | 'info' | 'warning' | 'destructive';

export interface AuditDescription {
  /** Friendly one-line sentence. */
  title: string;
  /** Optional secondary line (target / metadata summary). */
  detail?: string;
  Icon: LucideIcon;
  tone: AuditTone;
  /** Short category label, e.g. "Files", "Security". */
  category: string;
}

const meta = (e: AuditEntry) => (e.metadata ?? {}) as Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Last path segment (so `/movies/a.mkv` → `a.mkv`); falls back to the input. */
function baseName(p?: string | null): string {
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/** Category derived from the action's domain prefix. */
function categoryFor(action: string): { label: string; Icon: LucideIcon; tone: AuditTone } {
  const domain = action.split('.')[0];
  switch (domain) {
    case 'auth':
    case 'account':
      return { label: 'Security', Icon: ShieldCheck, tone: 'info' };
    case 'file':
    case 'files':
      return { label: 'Files', Icon: FolderInput, tone: 'neutral' };
    case 'torrents':
    case 'torrent':
      return { label: 'Torrents', Icon: Download, tone: 'neutral' };
    case 'media':
      return { label: 'Media', Icon: Film, tone: 'neutral' };
    case 'module':
    case 'modules':
      return { label: 'Modules', Icon: Boxes, tone: 'neutral' };
    case 'users':
    case 'roles':
      return { label: 'Users', Icon: Users, tone: 'neutral' };
    case 'settings':
      return { label: 'Settings', Icon: Settings, tone: 'neutral' };
    case 'apikeys':
      return { label: 'API Keys', Icon: KeyRound, tone: 'neutral' };
    case 'engines':
      return { label: 'Engines', Icon: ServerCog, tone: 'neutral' };
    case 'automation':
      return { label: 'Automation', Icon: Sparkles, tone: 'neutral' };
    default:
      return { label: 'System', Icon: Activity, tone: 'neutral' };
  }
}

/** Prettify an unknown action code as a last-resort title. */
function prettify(action: string): string {
  const segs = action.split('.');
  const verb = segs[segs.length - 1].replace(/_/g, ' ');
  const rest = segs.slice(0, -1).join(' ').replace(/_/g, ' ');
  const s = `${rest} ${verb}`.trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type Builder = (e: AuditEntry) => { title: string; detail?: string; Icon?: LucideIcon; tone?: AuditTone };

/** Per-action templates. Anything not listed falls back to {@link prettify}. */
const TEMPLATES: Record<string, Builder> = {
  // --- auth / account ---
  'auth.login': () => ({ title: 'Signed in', Icon: LogIn, tone: 'positive' }),
  'auth.logout': () => ({ title: 'Signed out', Icon: LogOut }),
  'auth.change_password': () => ({ title: 'Changed their password', Icon: Lock, tone: 'info' }),
  'account.password_changed': () => ({ title: 'Changed their password', Icon: Lock, tone: 'info' }),
  'account.2fa_enabled': () => ({ title: 'Enabled two-factor authentication', Icon: ShieldCheck, tone: 'positive' }),
  'account.2fa_disabled': () => ({ title: 'Disabled two-factor authentication', Icon: ShieldOff, tone: 'warning' }),

  // --- files ---
  'file.created_folder': (e) => ({ title: `Created folder ${baseName(e.objectId)}`, Icon: FolderPlus, tone: 'positive' }),
  'file.renamed': (e) => {
    const m = meta(e);
    return { title: `Renamed ${baseName(str(m.source) ?? e.objectId)} → ${baseName(str(m.destination))}`, Icon: FilePen };
  },
  'file.moved': (e) => {
    const m = meta(e);
    return { title: `Moved ${baseName(str(m.source) ?? e.objectId)} → ${str(m.destination) ?? ''}`, Icon: FolderInput };
  },
  'file.copied': (e) => {
    const m = meta(e);
    return { title: `Copied ${baseName(str(m.source) ?? e.objectId)}`, Icon: Copy };
  },
  'file.deleted': (e) => {
    const m = meta(e);
    const permanent = m.mode === 'permanent';
    const what = baseName(e.objectId) || 'an item';
    return permanent
      ? { title: `Permanently deleted ${what}`, Icon: Trash2, tone: 'destructive' }
      : { title: `Moved ${what} to Trash`, Icon: Trash2, tone: 'warning' };
  },
  'file.restore': (e) => ({ title: `Restored ${baseName(e.objectId)} from Trash`, Icon: RotateCcw, tone: 'positive' }),
  'file.trash_empty': (e) => {
    const m = meta(e);
    const n = num(m.removed);
    return { title: `Emptied the Trash${n != null ? ` (${n} item${n === 1 ? '' : 's'})` : ''}`, Icon: Trash2, tone: 'warning' };
  },
  'file.cleanup_execute': (e) => {
    const m = meta(e);
    const removed = num(m.removed) ?? 0;
    const bytes = num(m.bytesReclaimed) ?? num(m.bytes);
    return {
      title: `Cleaned up ${removed} item${removed === 1 ? '' : 's'}${bytes != null ? `, freed ${formatBytes(bytes)}` : ''}`,
      Icon: Sparkles,
      tone: 'warning',
    };
  },
  'file.operation_failed': (e) => {
    const m = meta(e);
    return { title: `File operation failed${m.intended ? `: ${str(m.intended)}` : ''}`, Icon: AlertTriangle, tone: 'destructive' };
  },

  // --- torrents ---
  'torrents.add': () => ({ title: 'Added a torrent', Icon: Plus, tone: 'positive' }),
  'torrents.delete': () => ({ title: 'Removed a torrent', Icon: Trash2, tone: 'warning' }),
  'torrents.stop': () => ({ title: 'Stopped a torrent', Icon: Square }),
  'torrents.start': () => ({ title: 'Started a torrent', Icon: Play }),
  'torrents.pause': () => ({ title: 'Paused a torrent', Icon: Pause }),
  'torrents.resume': () => ({ title: 'Resumed a torrent', Icon: Play }),
  'torrents.recheck': () => ({ title: 'Rechecked a torrent', Icon: RefreshCw }),

  // --- media ---
  'media.rename': (e) => {
    const m = meta(e);
    const applied = num(m.applied);
    return { title: `Ran the media renamer${applied != null ? ` (${applied} file${applied === 1 ? '' : 's'})` : ''}`, Icon: Film };
  },

  // --- automation ---
  'automation.rule.executed': (e) => {
    const m = meta(e);
    const rule = str(m.rule);
    // Success shows the torrent handled; failure shows why.
    const detail = str(m.error) ?? str(m.name);
    return { title: `Automation${rule ? `: ${rule}` : ''}`, detail, Icon: Sparkles, tone: 'neutral' };
  },

  // --- modules ---
  'module.enabled': (e) => ({ title: `Enabled the ${baseName(e.objectId) || 'module'} module`, Icon: Boxes, tone: 'positive' }),
  'module.disabled': (e) => ({ title: `Disabled the ${baseName(e.objectId) || 'module'} module`, Icon: Boxes, tone: 'warning' }),
  'module.access_denied': (e) => ({ title: `Access denied to ${baseName(e.objectId) || 'a module'}`, Icon: Ban, tone: 'warning' }),
};

/** Bulk verbs (`file.bulk.delete`, `torrents.bulk.removeData`). */
function bulkTitle(action: string, e: AuditEntry): { title: string; Icon: LucideIcon; tone: AuditTone } | null {
  const m = action.match(/^(file|torrents)\.bulk\.(.+)$/);
  if (!m) return null;
  const md = meta(e);
  const op = m[2];
  const count = num(md.total) ?? num(md.count) ?? num(md.succeeded);
  const noun = m[1] === 'file' ? 'item' : 'torrent';
  const verbMap: Record<string, string> = {
    delete: 'Deleted',
    remove: 'Removed',
    removeData: 'Removed (with data)',
    move: 'Moved',
    copy: 'Copied',
    pause: 'Paused',
    resume: 'Resumed',
    start: 'Started',
    stop: 'Stopped',
    recheck: 'Rechecked',
    cleanup: 'Cleaned up',
  };
  const verb = verbMap[op] ?? op;
  const n = count != null ? `${count} ${noun}${count === 1 ? '' : 's'}` : `${noun}s`;
  return { title: `${verb} ${n} in bulk`, Icon: ListChecks, tone: op === 'delete' || op.startsWith('remove') ? 'warning' : 'neutral' };
}

/** Compact one-line summary of the remaining metadata for the detail row. */
function metaSummary(e: AuditEntry): string | undefined {
  const m = meta(e);
  const parts: string[] = [];
  if (typeof m.succeeded === 'number' && typeof m.failed === 'number') {
    parts.push(`${m.succeeded} ok, ${m.failed} failed`);
  }
  if (typeof m.bytes === 'number' && m.bytes > 0) parts.push(formatBytes(m.bytes));
  return parts.length ? parts.join(' · ') : undefined;
}

/** The main entry point: humanize one audit row. */
export function describeAudit(entry: AuditEntry): AuditDescription {
  const cat = categoryFor(entry.action);

  let built = TEMPLATES[entry.action]?.(entry) ?? bulkTitle(entry.action, entry) ?? null;
  if (!built) built = { title: prettify(entry.action), Icon: cat.Icon, tone: cat.tone };

  // The detail line prefers a template-supplied one, then an explicit target,
  // else a metadata summary.
  const detail =
    built.detail ??
    (entry.objectId && !built.title.includes(baseName(entry.objectId))
      ? entry.objectId
      : metaSummary(entry));

  // A failed result always wins the tone and is flagged in the title.
  const failed = entry.result === 'failure';
  return {
    title: failed && !built.title.toLowerCase().includes('fail') ? `${built.title} — failed` : built.title,
    detail,
    Icon: failed ? AlertTriangle : built.Icon ?? cat.Icon,
    tone: failed ? 'destructive' : built.tone ?? cat.tone,
    category: cat.label,
  };
}

/** Tailwind classes for an icon chip per tone. */
export function toneChipClasses(tone: AuditTone): string {
  switch (tone) {
    case 'positive':
      return 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20';
    case 'info':
      return 'bg-sky-500/10 text-sky-400 ring-sky-500/20';
    case 'warning':
      return 'bg-amber-500/10 text-amber-400 ring-amber-500/20';
    case 'destructive':
      return 'bg-red-500/10 text-red-400 ring-red-500/20';
    default:
      return 'bg-white/5 text-muted-foreground ring-white/10';
  }
}
