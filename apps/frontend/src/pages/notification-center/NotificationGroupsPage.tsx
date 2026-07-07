import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, UsersRound } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';

export function NotificationGroupsPage() {
  const { t } = useTranslation('notificationCenter');
  const toast = useToast();
  const qc = useQueryClient();
  const groups = useQuery({ queryKey: ['nc', 'groups'], queryFn: () => api.notificationCenter.groups() });
  const recipients = useQuery({ queryKey: ['nc', 'recipients'], queryFn: () => api.notificationCenter.recipients() });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['nc', 'groups'] });
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; members: Set<string> } | null>(null);

  const create = useMutation({
    mutationFn: () => api.notificationCenter.createGroup({ name: name.trim() }),
    onSuccess: () => { setName(''); toast.success(t('groups.created')); invalidate(); },
    onError: (e) => toast.error(t('groups.saveFailed'), e instanceof ApiError ? e.message : undefined),
  });
  const remove = useMutation({ mutationFn: (id: string) => api.notificationCenter.deleteGroup(id), onSuccess: invalidate });
  const saveMembers = useMutation({
    mutationFn: () => api.notificationCenter.setGroupMembers(editing!.id, [...editing!.members]),
    onSuccess: () => { setEditing(null); toast.success(t('groups.membersSaved')); invalidate(); },
  });

  if (groups.isLoading) return <CenteredSpinner />;
  if (groups.isError) return <ErrorState title={t('groups.loadError')} onRetry={() => void groups.refetch()} />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('groups.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('groups.subtitle')}</p>
      </div>

      {(groups.data ?? []).map((g) => (
        <Card key={g.id}>
          <CardContent className="space-y-2 p-3">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <UsersRound className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">{g.name}</span>
              {g.system && <Badge variant="outline">{t('groups.system')}</Badge>}
              <span className="text-xs text-muted-foreground">{t('groups.members', { count: g.memberCount })}</span>
              <span className="flex-1" />
              <Button variant="secondary" size="sm" onClick={() => setEditing({ id: g.id, members: new Set() })}>{t('groups.editMembers')}</Button>
              {!g.system && <Button variant="ghost" size="sm" onClick={() => remove.mutate(g.id)}><Trash2 className="h-3.5 w-3.5" /></Button>}
            </div>
            {editing?.id === g.id && (
              <div className="space-y-2 rounded-md border border-white/10 p-3">
                <div className="flex flex-wrap gap-2">
                  {(recipients.data ?? []).map((r) => (
                    <label key={r.id} className="flex cursor-pointer items-center gap-1.5 rounded border border-white/10 px-2 py-1 text-xs">
                      <input type="checkbox" className="accent-amber-400" checked={editing.members.has(r.id)}
                        onChange={(e) => setEditing((cur) => { const m = new Set(cur!.members); e.target.checked ? m.add(r.id) : m.delete(r.id); return { ...cur!, members: m }; })} />
                      {r.displayName}
                    </label>
                  ))}
                  {(recipients.data ?? []).length === 0 && <span className="text-xs text-muted-foreground">{t('groups.noRecipients')}</span>}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => saveMembers.mutate()}>{t('groups.saveMembers')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>{t('groups.cancel')}</Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
      {(groups.data ?? []).length === 0 && <EmptyState title={t('groups.empty')} />}

      <Card>
        <CardContent className="flex flex-wrap items-end gap-2 p-4">
          <div className="space-y-1.5"><Label htmlFor="g-name">{t('groups.name')}</Label><Input id="g-name" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <Button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending}>{t('groups.createBtn')}</Button>
        </CardContent>
      </Card>
    </div>
  );
}
