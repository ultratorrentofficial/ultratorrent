import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

const SEV_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  info: 'secondary', warning: 'outline', critical: 'destructive',
};

export function NotificationRulesPage() {
  const { t } = useTranslation('notificationCenter');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['nc', 'rules'], queryFn: () => api.notificationCenter.rules() });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['nc', 'rules'] });
  const toggle = useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.notificationCenter.updateRule(id, { enabled }), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: string) => api.notificationCenter.deleteRule(id), onSuccess: invalidate });

  if (q.isLoading) return <CenteredSpinner />;
  if (q.isError) return <ErrorState title={t('rules.loadError')} onRetry={() => void q.refetch()} />;

  // Group rules by event namespace (media_server, download, rss, media, system).
  const rules = q.data ?? [];
  const groups = new Map<string, typeof rules>();
  for (const r of rules) {
    const ns = r.event.split('.')[0];
    if (!groups.has(ns)) groups.set(ns, []);
    groups.get(ns)!.push(r);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('rules.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('rules.subtitle')}</p>
      </div>

      {rules.length === 0 && <EmptyState title={t('rules.empty')} />}

      {[...groups.entries()].map(([ns, list]) => (
        <Card key={ns}>
          <CardContent className="p-3">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t(`eventGroup.${ns}`, { defaultValue: ns })}</h2>
            <div className="space-y-1">
              {list.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center gap-3 border-t border-white/5 py-1.5 text-sm first:border-0">
                  <Switch checked={r.enabled} onCheckedChange={(v) => toggle.mutate({ id: r.id, enabled: v })} />
                  <span className="font-medium">{r.name}</span>
                  <Badge variant={SEV_VARIANT[r.severity] ?? 'outline'}>{t(`severity.${r.severity}`, { defaultValue: r.severity })}</Badge>
                  <code className="text-xs text-muted-foreground">{r.event}</code>
                  {r.triggerCount > 0 && <span className="text-xs text-muted-foreground">{t('rules.triggered', { count: r.triggerCount })}</span>}
                  <span className="flex-1" />
                  {!r.system && <Button variant="ghost" size="sm" onClick={() => remove.mutate(r.id)}><Trash2 className="h-3.5 w-3.5" /></Button>}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
