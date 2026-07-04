import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Boxes, Lock } from 'lucide-react';
import { PERMISSIONS, SystemRole } from '@ultratorrent/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { TierBadge, StateBadge } from './moduleUi';

export function LockedModulePage({ moduleId }: { moduleId: string }) {
  const { t } = useTranslation('modules');
  const navigate = useNavigate();
  const { user, hasPermission } = useAuth();
  const isSuperAdmin = user?.roles?.includes(SystemRole.SUPER_ADMIN) ?? false;
  const canInspect = isSuperAdmin || hasPermission(PERMISSIONS.MODULES_VIEW);

  // Only admins can read module detail; normal users get a generic message.
  const { data: module } = useQuery({
    queryKey: ['modules', 'detail', moduleId],
    queryFn: () => api.modules.get(moduleId),
    enabled: canInspect,
  });

  const title = module?.name ?? prettyId(moduleId);

  return (
    <div className="mx-auto max-w-xl">
      <Card>
        <CardContent className="flex flex-col items-center gap-4 px-6 py-14 text-center">
          <div className="grid h-16 w-16 place-items-center rounded-2xl bg-white/[0.04] text-muted-foreground ring-1 ring-white/5">
            <Lock className="h-7 w-7" />
          </div>

          <div className="space-y-1.5">
            <h1 className="text-xl font-bold tracking-tight">{t('locked.notAvailable', { title })}</h1>
            {module && (
              <div className="flex flex-wrap items-center justify-center gap-2">
                <TierBadge tier={module.tier} />
                <StateBadge state={module.state} />
              </div>
            )}
          </div>

          {canInspect && module ? (
            <>
              <p className="max-w-md text-sm text-muted-foreground">{module.reason}</p>
              {module.unmetDependencies.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('locked.unmetDependencies')}
                  <span className="font-mono text-warning">
                    {module.unmetDependencies.join(', ')}
                  </span>
                </p>
              )}
              <Button variant="secondary" onClick={() => navigate('/modules')}>
                <Boxes className="h-4 w-4" /> {t('locked.manageModules')}
              </Button>
            </>
          ) : (
            <p className="max-w-md text-sm text-muted-foreground">{t('locked.noAccess')}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function prettyId(id: string): string {
  return id
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
