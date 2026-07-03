import { Navigate, Outlet, useLocation } from 'react-router-dom';
import type { Permission } from '@ultratorrent/shared';
import { useAuth } from './AuthContext';
import { CenteredSpinner } from '@/components/ui/feedback';

export interface ProtectedRouteProps {
  /** Optional permission required to view the route. */
  permission?: Permission | string;
}

export function ProtectedRoute({ permission }: ProtectedRouteProps) {
  const { status, hasPermission } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div className="grid min-h-screen place-items-center">
        <CenteredSpinner label="Loading session…" />
      </div>
    );
  }

  if (status === 'unauthenticated') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (permission && !hasPermission(permission)) {
    return (
      <div className="grid min-h-[60vh] place-items-center px-6 text-center">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold">Access denied</h1>
          <p className="text-sm text-muted-foreground">
            You do not have permission to view this page.
          </p>
        </div>
      </div>
    );
  }

  return <Outlet />;
}
