import { Navigate, useParams } from 'react-router-dom';
import { WorkspaceOverview } from '@/components/layout/WorkspaceOverview';
import { useVisibleNavGroups } from '@/components/layout/useVisibleNavGroups';

/**
 * A workspace's landing page: `/hub/:workspaceId` renders that workspace's
 * {@link WorkspaceOverview} (Quick Actions + navigable pages + live Jobs). Resolves the
 * workspace from the RBAC-filtered nav, so an overview for a workspace the user can't
 * see (or an unknown id) redirects home rather than 404-ing.
 */
export function ModuleHubPage() {
  const { domainId } = useParams<{ domainId: string }>();
  const groups = useVisibleNavGroups();
  const group = groups.find((g) => g.id === domainId);
  if (!group) return <Navigate to="/dashboard" replace />;
  return <WorkspaceOverview group={group} />;
}
