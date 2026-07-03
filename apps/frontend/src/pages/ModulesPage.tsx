import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, CheckCircle2, Power, PowerOff, ShieldAlert } from 'lucide-react';
import type { ModuleStatus, ModuleTier } from '@ultratorrent/shared';
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

const TIER_HEADING: Record<ModuleTier, string> = {
  core: 'Core',
  community: 'Community',
  premium: 'Premium',
  enterprise: 'Enterprise',
};

export function ModulesPage() {
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
      toast.success(next ? 'Module enabled' : 'Module disabled', module.name);
      invalidate();
    } catch (err) {
      toast.error(
        next ? 'Could not enable module' : 'Could not disable module',
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
        <h1 className="text-2xl font-bold tracking-tight">Modules</h1>
        <p className="text-sm text-muted-foreground">
          Enable or disable optional capabilities. Core modules are always on.
        </p>
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
                  <span className="text-sm font-semibold capitalize">{license.edition} edition</span>
                  <Badge variant={license.valid ? 'success' : 'warning'} dot>
                    {license.valid ? 'Valid' : license.expired ? 'Expired' : 'Invalid'}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {license.licensee ? `Licensed to ${license.licensee}. ` : ''}
                  {license.expiresAt
                    ? `Expires ${formatDateTime(license.expiresAt)}.`
                    : 'No expiry.'}
                </p>
              </div>
            </div>
            <Badge variant="outline">
              {license.modules.includes('*')
                ? 'All modules unlocked'
                : `${license.modules.length} module${license.modules.length === 1 ? '' : 's'} unlocked`}
            </Badge>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <CenteredSpinner label="Loading modules…" />
      ) : isError ? (
        <ErrorState message="Could not load modules." onRetry={() => refetch()} />
      ) : !data || data.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState icon={<Boxes className="h-6 w-6" />} title="No modules" />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {grouped.map((group) => (
            <div key={group.tier} className="space-y-3">
              <h2 className="text-sm font-semibold text-muted-foreground">
                {TIER_HEADING[group.tier]}
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
              title={health ? `Health: ${health.status}` : 'Health unknown'}
            />
            <p className="font-semibold">{module.name}</p>
            <code className="rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
              {module.id}
            </code>
            <TierBadge tier={module.tier} />
            <StateBadge state={module.state} />
            <Badge variant={module.licensed ? 'success' : 'secondary'}>
              {module.licensed ? 'licensed' : 'unlicensed'}
            </Badge>
          </div>

          {module.description && (
            <p className="mt-1.5 text-sm text-muted-foreground">{module.description}</p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              {module.permissions.length} permission{module.permissions.length === 1 ? '' : 's'}
            </span>
            {module.dependencies.length > 0 && (
              <span className="flex flex-wrap items-center gap-1">
                deps:
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
              <Badge variant="outline" title="Core — always on">
                core — always on
              </Badge>
            ) : module.enabled ? (
              <Button variant="outline" size="sm" onClick={() => onToggle(false)}>
                <PowerOff className="h-4 w-4" /> Disable
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => onToggle(true)}>
                <Power className="h-4 w-4" /> Enable
              </Button>
            ))}
        </div>
      </CardContent>
    </Card>
  );
}
