import { useQuery } from '@tanstack/react-query';
import { api, type SystemVersion } from '@/lib/api';

/**
 * Platform identity + version from the public `GET /api/system/version`.
 * The version is the single source of truth (`version.json` → VERSION file),
 * so it is cached aggressively — it only changes on deploy.
 */
export function useVersion() {
  return useQuery<SystemVersion>({
    queryKey: ['system', 'version'],
    queryFn: api.system.version,
    staleTime: 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: 1,
  });
}
