import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, FolderTree, Save, Settings2 } from 'lucide-react';
import { ApiError, api, type AppSettings } from '@/lib/api';
import { PERMISSIONS } from '@ultratorrent/shared';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { PathPicker } from '@/components/PathPicker';
import { useEnsureDirectory } from '@/components/path/EnsureDirectory';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { EmailSettingsCard } from '@/pages/media-server-analytics/EmailSettingsCard';
import { NewsletterImagesCard } from '@/pages/media-server-analytics/NewsletterImagesCard';

/** Owned by the dedicated Default Root Path section — not the generic list. */
const ROOT_PATH_KEY = 'fileManager.defaultRootPath';

/** Render a settings object generically — the backend owns the schema. */
export function SettingsPage() {
  const { hasPermission } = useAuth();
  const { t } = useTranslation('settings');
  const toast = useToast();
  const queryClient = useQueryClient();
  const canManage = hasPermission(PERMISSIONS.SETTINGS_MANAGE);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['settings'],
    queryFn: api.settings.get,
  });

  const [draft, setDraft] = useState<AppSettings>({});
  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  const mutation = useMutation({
    mutationFn: (patch: AppSettings) => api.settings.update(patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(['settings'], updated);
      toast.success(t('toast.saved'));
    },
    onError: (err) => toast.error(t('toast.saveFailed'), err instanceof ApiError ? err.message : undefined),
  });

  // The Default Root Path has its own validated + audited route; keep it out of
  // the generic list (the protected key is also rejected by PATCH /settings).
  const entries = Object.entries(draft).filter(([key]) => key !== ROOT_PATH_KEY);

  const setValue = (key: string, value: unknown) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('page.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('page.subtitle')}</p>
        </div>
        {canManage && entries.length > 0 && (
          <Button
            onClick={() => mutation.mutate(Object.fromEntries(entries))}
            loading={mutation.isPending}
          >
            <Save className="h-4 w-4" /> {t('page.save')}
          </Button>
        )}
      </div>

      <RootPathSection canManageRoot={hasPermission(PERMISSIONS.SETTINGS_MANAGE_ROOT_PATH)} />

      {hasPermission(PERMISSIONS.MEDIA_SERVER_ANALYTICS_MANAGE_SETTINGS) && <EmailSettingsCard />}
      {hasPermission(PERMISSIONS.MEDIA_SERVER_ANALYTICS_MANAGE_SETTINGS) && <NewsletterImagesCard />}

      {isLoading ? (
        <CenteredSpinner label={t('page.loading')} />
      ) : isError ? (
        <ErrorState message={t('page.error')} onRetry={() => refetch()} />
      ) : entries.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={<Settings2 className="h-6 w-6" />}
              title={t('page.emptyTitle')}
              description={t('page.emptyDescription')}
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{t('page.generalTitle')}</CardTitle>
            <CardDescription>{t('page.generalDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="divide-y divide-border/60">
            {entries.map(([key, value]) => (
              <SettingRow
                key={key}
                name={key}
                value={value}
                disabled={!canManage}
                onChange={(v) => setValue(key, v)}
              />
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function RootPathSection({ canManageRoot }: { canManageRoot: boolean }) {
  const { t } = useTranslation('settings');
  const toast = useToast();
  const queryClient = useQueryClient();
  const { ensure: ensureDirectory, dialog: ensureDirectoryDialog } = useEnsureDirectory();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['files', 'root'],
    queryFn: api.files.root,
  });
  const [value, setValue] = useState('');
  useEffect(() => {
    if (data) setValue(data.configured ?? data.root);
  }, [data]);

  const save = useMutation({
    mutationFn: (p: string) => api.files.setRoot(p.trim()),
    onSuccess: (info) => {
      queryClient.setQueryData(['files', 'root'], info);
      queryClient.invalidateQueries({ queryKey: ['files', 'browse'] });
      toast.success(t('rootPath.savedToast'), info.root);
    },
    onError: (err) =>
      toast.error(t('rootPath.saveFailedToast'), err instanceof ApiError ? err.message : undefined),
  });

  // Validate the root against the hard roots and offer to create it if missing.
  const doSave = async () => {
    if (!(await ensureDirectory(value))) return;
    save.mutate(value);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FolderTree className="h-4 w-4 text-primary" /> {t('rootPath.title')}
        </CardTitle>
        <CardDescription>{t('rootPath.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <CenteredSpinner label={t('rootPath.loading')} />
        ) : isError ? (
          <ErrorState message={t('rootPath.error')} onRetry={() => refetch()} />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">{t('rootPath.effectiveRoot')}</span>
              <code className="rounded bg-white/5 px-2 py-0.5 font-mono">{data?.root}</code>
              <Badge variant={data?.exists ? 'success' : 'destructive'} dot>
                {data?.exists ? t('rootPath.exists') : t('rootPath.missing')}
              </Badge>
              <Badge variant={data?.readable ? 'success' : 'destructive'} dot>
                {data?.readable ? t('rootPath.readable') : t('rootPath.notReadable')}
              </Badge>
              <Badge variant={data?.writable ? 'success' : 'warning'} dot>
                {data?.writable ? t('rootPath.writable') : t('rootPath.readOnly')}
              </Badge>
            </div>

            {data && !data.writable && (
              <p className="flex items-start gap-1.5 text-xs text-warning">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {t('rootPath.notWritableWarning')}
              </p>
            )}

            {canManageRoot ? (
              <div className="space-y-2">
                <Label htmlFor="root-path">{t('rootPath.label')}</Label>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <PathPicker
                    id="root-path"
                    value={value}
                    onChange={setValue}
                    placeholder={data?.hardRoots?.[0] ?? '/downloads'}
                    aria-label={t('rootPath.ariaLabel')}
                    pickerTitle={t('rootPath.pickerTitle')}
                    className="flex-1"
                  />
                  <Button
                    onClick={() => void doSave()}
                    loading={save.isPending}
                    disabled={!value.trim()}
                    className="shrink-0"
                  >
                    <Save className="h-4 w-4" /> {t('rootPath.save')}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('rootPath.help.before')}
                  <code className="font-mono">{data?.hardRoots?.join(', ') || '—'}</code>
                  {t('rootPath.help.after')}
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t('rootPath.adminOnly.before')}
                <code className="font-mono">settings.manage_root_path</code>
                {t('rootPath.adminOnly.after')}
              </p>
            )}
          </>
        )}
      </CardContent>
      {ensureDirectoryDialog}
    </Card>
  );
}

function SettingRow({
  name,
  value,
  disabled,
  onChange,
}: {
  name: string;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const label = name
    .replace(/[_.]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^\w/, (c) => c.toUpperCase());

  const isObject = value !== null && typeof value === 'object';

  return (
    <div className="flex items-center justify-between gap-4 py-3.5">
      <div className="min-w-0">
        <Label className="block">{label}</Label>
        <p className="truncate font-mono text-xs text-muted-foreground">{name}</p>
      </div>
      <div className="w-full max-w-xs shrink-0">
        {typeof value === 'boolean' ? (
          <div className="flex justify-end">
            <Switch checked={value} onCheckedChange={onChange} disabled={disabled} aria-label={label} />
          </div>
        ) : typeof value === 'number' ? (
          <Input
            type="number"
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(Number(e.target.value))}
          />
        ) : isObject ? (
          <code className="block truncate rounded bg-white/5 px-2 py-1 text-xs text-muted-foreground">
            {JSON.stringify(value)}
          </code>
        ) : (
          <Input
            value={String(value ?? '')}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
      </div>
    </div>
  );
}
