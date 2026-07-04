import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, CheckCircle2, Power, PowerOff, ShieldAlert } from 'lucide-react';
import type { ModuleStatus } from '@ultratorrent/shared';
import { PERMISSIONS } from '@ultratorrent/shared';
import { ApiError, api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';
import { StateBadge, TierBadge, TIER_ORDER } from '@/modules/moduleUi';

export function ModulesPage() {
  const { t } = useTranslation('modules');
  const toast = useToast();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.MODULES_MANAGE);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['modules', 'all'],
    queryFn: api.modules.list,
  });
  const { data: license } = useQuery({
    queryKey: ['modules', 'license'],
    queryFn: api.modules.license,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['modules', 'all'] });
    queryClient.invalidateQueries({ queryKey: ['modules', 'enabled'] });
  };

  const toggle = async (module: ModuleStatus, next: boolean) => {
    try {
      if (next) await api.modules.enable(module.id);
      else await api.modules.disable(module.id);
      toast.success(next ? t('toast.enabled') : t('toast.disabled'), module.name);
      invalidate();
    } catch (err) {
      toast.error(
        next ? t('toast.enableFailed') : t('toast.disableFailed'),
        err instanceof ApiError ? err.message : undefined,
      );
    }
  };

  const grouped = TIER_ORDER.map((tier) => ({
    tier,
    modules: (data ?? []).filter((m) => m.tier === tier),
  })).filter((g) => g.modules.length > 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('page.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('page.subtitle')}</p>
      </div>

      {license && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="flex items-center gap-3">
              {license.valid ? (
                <CheckCircle2 className="h-5 w-5 text-success" />
              ) : (
                <ShieldAlert className="h-5 w-5 text-warning" />
              )}
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold capitalize">
                    {t('license.edition', { edition: license.edition })}
                  </span>
                  <Badge variant={license.valid ? 'success' : 'warning'} dot>
                    {license.valid
                      ? t('license.valid')
                      : license.expired
                        ? t('license.expired')
                        : t('license.invalid')}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {license.licensee ? t('license.licensedTo', { licensee: license.licensee }) : ''}
                  {license.expiresAt
                    ? t('license.expires', { date: formatDateTime(license.expiresAt) })
                    : t('license.noExpiry')}
                </p>
              </div>
            </div>
            <Badge variant="outline">
              {license.modules.includes('*')
                ? t('license.allUnlocked')
                : t('license.unlocked', { count: license.modules.length })}
            </Badge>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <CenteredSpinner label={t('list.loading')} />
      ) : isError ? (
        <ErrorState message={t('list.error')} onRetry={() => refetch()} />
      ) : !data || data.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState icon={<Boxes className="h-6 w-6" />} title={t('list.empty')} />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {grouped.map((group) => (
            <div key={group.tier} className="space-y-3">
              <h2 className="text-sm font-semibold text-muted-foreground">
                {t(`tier.${group.tier}`)}
              </h2>
              {group.modules.map((module) => (
                <ModuleCard
                  key={module.id}
                  module={module}
                  canManage={canManage}
                  onToggle={(next) => toggle(module, next)}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ModuleCard({
  module,
  canManage,
  onToggle,
}: {
  module: ModuleStatus;
  canManage: boolean;
  onToggle: (next: boolean) => void;
}) {
  const { t } = useTranslation('modules');
  const { data: health } = useQuery({
    queryKey: ['modules', 'health', module.id],
    queryFn: () => api.modules.health(module.id),
  });

  const healthTone =
    health?.status === 'healthy'
      ? 'bg-success'
      : health?.status === 'degraded'
        ? 'bg-warning'
        : health?.status === 'locked'
          ? 'bg-destructive'
          : 'bg-muted-foreground/50';

  // Core modules are locked on; they cannot be disabled.
  const isLockedCore = module.locked;

  return (
    <Card>
      <CardContent className="flex flex-wrap items-start justify-between gap-4 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn('h-2.5 w-2.5 shrink-0 rounded-full', healthTone)}
              title={health ? t('card.healthLabel', { status: health.status }) : t('card.healthUnknown')}
            />
            <p className="font-semibold">{module.name}</p>
            <code className="rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
              {module.id}
            </code>
            <TierBadge tier={module.tier} />
            <StateBadge state={module.state} />
            <Badge variant={module.licensed ? 'success' : 'secondary'}>
              {module.licensed ? t('card.licensed') : t('card.unlicensed')}
            </Badge>
          </div>

          {module.description && (
            <p className="mt-1.5 text-sm text-muted-foreground">{module.description}</p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{t('card.permissions', { count: module.permissions.length })}</span>
            {module.dependencies.length > 0 && (
              <span className="flex flex-wrap items-center gap-1">
                {t('card.deps')}
                {module.dependencies.map((dep) => (
                  <code
                    key={dep}
                    className={cn(
                      'rounded px-1 py-0.5 font-mono',
                      module.unmetDependencies.includes(dep)
                        ? 'bg-warning/15 text-warning'
                        : 'bg-white/[0.04]',
                    )}
                  >
                    {dep}
                  </code>
                ))}
              </span>
            )}
          </div>

          {module.reason && (
            <p className="mt-1.5 text-xs text-muted-foreground/80">{module.reason}</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {canManage &&
            (isLockedCore ? (
              <Badge variant="outline" title={t('card.coreAlwaysOnTitle')}>
                {t('card.coreAlwaysOn')}
              </Badge>
            ) : module.enabled ? (
              <Button variant="outline" size="sm" onClick={() => onToggle(false)}>
                <PowerOff className="h-4 w-4" /> {t('card.disable')}
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => onToggle(true)}>
                <Power className="h-4 w-4" /> {t('card.enable')}
              </Button>
            ))}
        </div>
      </CardContent>
    </Card>
  );
}
