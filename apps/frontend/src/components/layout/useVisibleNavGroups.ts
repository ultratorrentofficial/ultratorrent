import { useMemo } from 'react';
import { PERMISSIONS, SystemRole } from '@ultratorrent/shared';
import { useAuth } from '@/auth/AuthContext';
import { useModules } from '@/modules/ModuleContext';
import { visibleGroups, type NavGroup } from '@/components/layout/navigation';

/**
 * The RBAC- and module-filtered navigation domains for the current user — the same
 * data the sidebar renders, made available to pages (e.g. the module hubs). External
 * items (Prowlarr) resolve their URL in the shell only, so they simply drop out here.
 */
export function useVisibleNavGroups(): NavGroup[] {
  const { hasPermission, user } = useAuth();
  const { isEnabled } = useModules();
  return useMemo(
    () =>
      visibleGroups({
        hasPermission,
        isEnabled,
        canManageModules: hasPermission(PERMISSIONS.MODULES_MANAGE),
        isSuperAdmin: Boolean(user?.roles?.includes(SystemRole.SUPER_ADMIN)),
      }),
    [hasPermission, isEnabled, user],
  );
}
