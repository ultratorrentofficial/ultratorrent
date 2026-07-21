import { Navigate, useParams } from 'react-router-dom';
import { ModuleHub } from '@/components/layout/ModuleHub';
import { useVisibleNavGroups } from '@/components/layout/useVisibleNavGroups';

/**
 * Generic domain landing page: `/hub/:domainId` renders the {@link ModuleHub} for a
 * navigation domain. Resolves the domain from the RBAC-filtered nav, so a hub for a
 * domain the user can't see (or an unknown id) redirects home rather than 404-ing.
 */
export function ModuleHubPage() {
  const { domainId } = useParams<{ domainId: string }>();
  const groups = useVisibleNavGroups();
  const group = groups.find((g) => g.id === domainId);
  if (!group) return <Navigate to="/dashboard" replace />;
  return <ModuleHub group={group} />;
}
