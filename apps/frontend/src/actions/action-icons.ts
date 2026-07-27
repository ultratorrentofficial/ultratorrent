/**
 * Icon names → components.
 *
 * The registry ships a *name* rather than a component because the descriptor is
 * declared on the server, which has no React. This map is the client half.
 *
 * An unknown name yields `null` and the action renders with its label alone,
 * which is the right failure: a module contributing an action the frontend has
 * not seen should still be usable, and a missing icon is not a reason to hide a
 * permitted action. Adding an icon is a one-line change here, not a release
 * requirement for the contributing module.
 */
import {
  Ban,
  Download,
  FileCog,
  Lock,
  Pause,
  PenLine,
  Play,
  RefreshCw,
  RotateCw,
  ScanLine,
  Square,
  Trash2,
  Unlock,
  type LucideIcon,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  Ban,
  Download,
  FileCog,
  Lock,
  Pause,
  PenLine,
  Play,
  RefreshCw,
  RotateCw,
  ScanLine,
  Square,
  Trash2,
  Unlock,
};

export function actionIcon(name: string | undefined): LucideIcon | null {
  if (!name) return null;
  return ICONS[name] ?? null;
}
