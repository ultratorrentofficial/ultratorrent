import { createContext, useContext, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { LicenseStatus, ModuleStatus } from '@ultratorrent/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';

interface ModuleContextValue {
  /** Ids of modules that are currently enabled (and visible to this user). */
  enabledModuleIds: Set<string>;
  /** The enabled module records returned by /modules/enabled. */
  modules: ModuleStatus[];
  license: LicenseStatus | undefined;
  isLoading: boolean;
  isEnabled: (id: string) => boolean;
  /** Alias of isEnabled for feature-gating call sites. */
  hasModule: (id: string) => boolean;
}

const ModuleContext = createContext<ModuleContextValue | null>(null);

export function ModuleProvider({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const authenticated = status === 'authenticated';

  const modulesQuery = useQuery({
    queryKey: ['modules', 'enabled'],
    queryFn: api.modules.enabled,
    enabled: authenticated,
    staleTime: 60_000,
  });

  const licenseQuery = useQuery({
    queryKey: ['modules', 'license'],
    queryFn: api.modules.license,
    enabled: authenticated,
    staleTime: 60_000,
  });

  const value = useMemo<ModuleContextValue>(() => {
    const modules = modulesQuery.data ?? [];
    const enabledModuleIds = new Set(modules.map((m) => m.id));
    // Until the first fetch resolves, treat modules as enabled so nav/routes
    // don't flicker on load. The backend remains the authoritative gate.
    const ready = modulesQuery.data !== undefined;
    const isEnabled = (id: string) => (ready ? enabledModuleIds.has(id) : true);
    return {
      enabledModuleIds,
      modules,
      license: licenseQuery.data,
      isLoading: modulesQuery.isLoading,
      isEnabled,
      hasModule: isEnabled,
    };
  }, [modulesQuery.data, modulesQuery.isLoading, licenseQuery.data]);

  return <ModuleContext.Provider value={value}>{children}</ModuleContext.Provider>;
}

export function useModules(): ModuleContextValue {
  const ctx = useContext(ModuleContext);
  if (!ctx) throw new Error('useModules must be used within <ModuleProvider>');
  return ctx;
}
