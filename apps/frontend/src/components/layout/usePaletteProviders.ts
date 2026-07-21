import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Copy, Download, Film, Library, Rss, ScanSearch, Bot, Users, Briefcase } from 'lucide-react';
import { PERMISSIONS } from '@ultratorrent/shared';
import { api, type JobSubsystem } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { useModules } from '@/modules/ModuleContext';
import type { PaletteAction, PaletteEntitySource } from '@/components/layout/CommandPalette';

/** Where a job result navigates — the workspace Overview whose Jobs widget owns it. */
const JOB_SUBSYSTEM_LANDING: Record<JobSubsystem, string> = {
  media: '/hub/media',
  subtitle: '/hub/media',
  rename: '/hub/media',
  analytics_import: '/hub/analytics',
  notification: '/hub/automation',
};

/**
 * Quick actions and live entity search for the command palette.
 *
 * Both are permission- and module-gated, so the palette only ever offers what the
 * user can actually do or reach, and each is tagged with a `scope` (workspace id) so
 * the palette's scoped search can narrow to the active workspace. Actions are
 * navigational shortcuts; entity sources search the backend live. Adding a source is
 * one gated entry here — the palette renders whatever this returns.
 */
export function usePaletteProviders(): { actions: PaletteAction[]; entitySources: PaletteEntitySource[] } {
  const navigate = useNavigate();
  const { t } = useTranslation('shell');
  const { hasPermission } = useAuth();
  const { isEnabled } = useModules();

  const canMedia = hasPermission(PERMISSIONS.MEDIA_MANAGER_VIEW) && isEnabled('media_manager');
  const canRss = hasPermission(PERMISSIONS.RSS_VIEW) && isEnabled('rss');
  const canUsers = hasPermission(PERMISSIONS.USERS_VIEW) && isEnabled('users');

  const actions = useMemo<PaletteAction[]>(() => {
    const out: PaletteAction[] = [];
    if (hasPermission(PERMISSIONS.TORRENTS_ADD) && isEnabled('torrents')) {
      out.push({ id: 'add-torrent', label: t('command.action.addTorrent'), icon: Download, keywords: 'magnet upload', scope: 'downloads', run: () => navigate('/torrents') });
    }
    if (canMedia) {
      out.push({ id: 'scan-library', label: t('command.action.scanLibrary'), icon: ScanSearch, keywords: 'index media', scope: 'media', run: () => navigate('/media/libraries') });
      out.push({ id: 'find-duplicates', label: t('command.action.findDuplicates'), icon: Copy, keywords: 'duplicate cleanup', scope: 'media', run: () => navigate('/media/duplicates') });
    }
    if (canRss) {
      out.push({ id: 'rss-rule', label: t('command.action.createRssRule'), icon: Rss, keywords: 'feed subscribe', scope: 'downloads', run: () => navigate('/rss') });
    }
    if (hasPermission(PERMISSIONS.AUTOMATION_VIEW) && isEnabled('automation')) {
      out.push({ id: 'automation', label: t('command.action.runAutomation'), icon: Bot, keywords: 'rule trigger', scope: 'automation', run: () => navigate('/automation') });
    }
    return out;
  }, [t, navigate, hasPermission, isEnabled, canMedia, canRss]);

  const entitySources = useMemo<PaletteEntitySource[]>(() => {
    const out: PaletteEntitySource[] = [];
    if (canMedia) {
      out.push({
        key: 'media-items',
        title: t('command.entity.media'),
        scope: 'media',
        search: async (q) => {
          const page = await api.media.listItems({ search: q, pageSize: 6 });
          return page.items.map((i) => ({
            id: i.id,
            label: i.year ? `${i.title} (${i.year})` : i.title,
            sublabel: i.path,
            icon: Film,
            to: `/media/items/${i.id}`,
          }));
        },
      });
      out.push({
        key: 'libraries',
        title: t('command.entity.libraries'),
        scope: 'media',
        search: async (q) => {
          const libs = await api.media.libraries();
          const ql = q.toLowerCase();
          return libs
            .filter((l) => l.name.toLowerCase().includes(ql) || l.path.toLowerCase().includes(ql))
            .slice(0, 6)
            .map((l) => ({ id: l.id, label: l.name, sublabel: l.path, icon: Library, to: '/media/libraries' }));
        },
      });
    }
    if (canRss) {
      out.push({
        key: 'rss-rules',
        title: t('command.entity.rssRules'),
        scope: 'downloads',
        search: async (q) => {
          const rules = await api.rss.rules();
          const ql = q.toLowerCase();
          return rules
            .filter((r) => r.name.toLowerCase().includes(ql) || r.feedName.toLowerCase().includes(ql))
            .slice(0, 6)
            .map((r) => ({ id: r.id, label: r.name, sublabel: r.feedName, icon: Rss, to: `/rss/rules/${r.id}` }));
        },
      });
    }
    if (canUsers) {
      out.push({
        key: 'users',
        title: t('command.entity.users'),
        scope: 'administration',
        search: async (q) => {
          const page = await api.users.list({ pageSize: 20 } as never);
          const ql = q.toLowerCase();
          return page.items
            .filter((u) =>
              u.username.toLowerCase().includes(ql) ||
              u.email.toLowerCase().includes(ql) ||
              (u.displayName ?? '').toLowerCase().includes(ql),
            )
            .slice(0, 6)
            .map((u) => ({ id: u.id, label: u.displayName ?? u.username, sublabel: u.email, icon: Users, to: '/users' }));
        },
      });
    }
    // Jobs — always available (the endpoint is RBAC-scoped server-side; an
    // unauthorised subsystem simply returns nothing). Results open the workspace
    // Overview whose Jobs widget owns them.
    out.push({
      key: 'jobs',
      title: t('command.entity.jobs'),
      scope: 'system',
      search: async (q) => {
        const { jobs } = await api.jobs.list({ limit: 40 });
        const ql = q.toLowerCase();
        return jobs
          .filter((j) => j.type.toLowerCase().includes(ql) || (j.label ?? '').toLowerCase().includes(ql) || j.subsystem.includes(ql))
          .slice(0, 6)
          .map((j) => ({
            id: j.id,
            label: j.type,
            sublabel: [j.label, j.status].filter(Boolean).join(' · '),
            icon: Briefcase,
            to: JOB_SUBSYSTEM_LANDING[j.subsystem],
          }));
      },
    });
    return out;
  }, [t, canMedia, canRss, canUsers]);

  return { actions, entitySources };
}
