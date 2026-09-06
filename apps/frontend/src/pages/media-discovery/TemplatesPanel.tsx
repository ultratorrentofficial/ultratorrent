import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileStack, Pencil, Plus, Power, Trash2 } from 'lucide-react';
import { api, type DiscoveryTemplate } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import { TemplateForm } from './TemplateForm';

/**
 * Discovery templates: what the engine is allowed to monitor on its own.
 *
 * The list leads with whether each template is ON, because that is the only
 * property that decides whether anything happens. A disabled template is
 * configuration; an enabled one is a standing instruction to acquire media, and
 * the difference should not need reading to spot.
 */
export function TemplatesPanel() {
  const { t } = useTranslation('mediaDiscovery');
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<DiscoveryTemplate | 'new' | null>(null);

  const templates = useQuery({
    queryKey: ['discovery', 'templates'],
    queryFn: () => api.mediaDiscovery.templates(),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['discovery'] });

  const toggle = useMutation({
    mutationFn: (tpl: DiscoveryTemplate) =>
      api.mediaDiscovery.updateTemplate(tpl.id, { enabled: !tpl.enabled }),
    onSuccess: invalidate,
    // Enabling is refused when the template cannot do what it claims; the
    // server's message names the missing piece, so it is shown verbatim.
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.mediaDiscovery.deleteTemplate(id),
    onSuccess: () => {
      toast.success(t('templates.deleted'));
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (editing) {
    return (
      <TemplateForm
        template={editing === 'new' ? undefined : editing}
        onSaved={() => {
          setEditing(null);
          invalidate();
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  if (templates.isLoading) return <CenteredSpinner />;
  if (templates.isError) return <ErrorState title={t('templates.error')} />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{t('templates.explainer')}</p>
        <Button onClick={() => setEditing('new')}>
          <Plus className="h-3.5 w-3.5" />
          {t('templates.create')}
        </Button>
      </div>

      {templates.data?.length === 0 && (
        <EmptyState
          icon={<FileStack className="h-6 w-6" />}
          title={t('templates.emptyTitle')}
          description={t('templates.emptyDescription')}
        />
      )}

      <div className="grid gap-2">
        {(templates.data ?? []).map((tpl) => {
          const canAuto = tpl.autoMonitorCategories.length > 0;
          return (
            <Card key={tpl.id}>
              <CardContent className="flex flex-wrap items-start justify-between gap-3 p-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{tpl.name}</span>
                    <Badge
                      variant="outline"
                      className={
                        tpl.enabled
                          ? 'border-emerald-400/40 bg-emerald-400/10 text-[10px] text-emerald-300'
                          : 'text-[10px]'
                      }
                    >
                      {tpl.enabled ? t('templates.on') : t('templates.off')}
                    </Badge>
                    <span className="text-[11px] text-muted-foreground">
                      {tpl.mediaType === 'any' ? t('form.anyType') : tpl.mediaType.toUpperCase()}
                    </span>
                    {/*
                      * A template with no auto-monitor categories never creates
                      * anything. Saying so on the row stops it reading as broken.
                      */}
                    {!canAuto && (
                      <Badge variant="outline" className="text-[10px]">{t('templates.notifyOnly')}</Badge>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {t('templates.summary', {
                      auto: tpl.autoMonitorCategories.length,
                      notify: tpl.notifyOnlyCategories.length,
                      ignore: tpl.ignoreCategories.length,
                      days: tpl.upcomingWindowDays,
                    })}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {t('templates.limits', { perDay: tpl.autoAddLimitPerDay, perWeek: tpl.autoAddLimitPerWeek })}
                  </p>
                </div>

                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant={tpl.enabled ? 'secondary' : 'primary'}
                    onClick={() => toggle.mutate(tpl)}
                    disabled={toggle.isPending}
                  >
                    <Power className="h-3.5 w-3.5" />
                    {tpl.enabled ? t('templates.disable') : t('templates.enable')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(tpl)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (window.confirm(t('templates.confirmDelete', { name: tpl.name }))) {
                        remove.mutate(tpl.id);
                      }
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
