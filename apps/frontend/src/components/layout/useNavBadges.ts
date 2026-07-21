import { useQuery } from '@tanstack/react-query';
import { PERMISSIONS } from '@ultratorrent/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { useModules } from '@/modules/ModuleContext';

/** A live status badge for a nav item. `count` renders a number; `dot` a plain marker. */
export interface NavBadge {
  count?: number;
  tone?: 'info' | 'warning' | 'danger';
  /** Accessible description, e.g. "12 duplicate groups need review". */
  label?: string;
}

/**
 * Live status badges keyed by nav item id.
 *
 * Each source is **permission- and module-gated and lazy** — a query never runs for a
 * surface the user can't see — so the rail stays cheap as more badges are added. Add
 * a badge by wiring one gated query and mapping its result to an item id here; the
 * sidebar renders whatever this returns.
 */
export function useNavBadges(): Record<string, NavBadge> {
  const { hasPermission } = useAuth();
  const { isEnabled } = useModules();
  const badges: Record<string, NavBadge> = {};

  // Duplicate Center — groups awaiting a human decision. Actionable, so it earns a
  // badge; a resolved/ignored count would just be noise.
  const canDuplicates = hasPermission(PERMISSIONS.MEDIA_MANAGER_VIEW) && isEnabled('media_manager');
  const duplicates = useQuery({
    queryKey: ['nav-badge', 'duplicates'],
    queryFn: () => api.media.duplicatesOverview(),
    enabled: canDuplicates,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
  if (duplicates.data && duplicates.data.needsReview > 0) {
    badges['media-duplicates'] = {
      count: duplicates.data.needsReview,
      tone: 'warning',
      label: `${duplicates.data.needsReview} duplicate group(s) need review`,
    };
  }

  return badges;
}
