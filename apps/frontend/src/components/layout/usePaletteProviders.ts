import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Copy, Download, Film, Library, Rss, ScanSearch, Bot } from 'lucide-react';
import { PERMISSIONS } from '@ultratorrent/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { useModules } from '@/modules/ModuleContext';
import type { PaletteAction, PaletteEntitySource } from '@/components/layout/CommandPalette';

/**
 * Quick actions and live entity search for the command palette.
 *
 * Both are permission- and module-gated, so the palette only ever offers what the
 * user can actually do or reach. Actions are navigational shortcuts (they open the
 * page where the operation lives); entity sources search the backend live. Adding a
 * source is one gated entry here — the palette renders whatever this returns.
 */
export function usePaletteProviders(): { actions: PaletteAction[]; entitySources: PaletteEntitySource[] } {
  const navigate = useNavigate();
  const { t } = useTranslation('shell');
  const { hasPermission } = useAuth();
  const { isEnabled } = useModules();

  const canMedia = hasPermission(PERMISSIONS.MEDIA_MANAGER_VIEW) && isEnabled('media_manager');

  const actions = useMemo<PaletteAction[]>(() => {
    const out: PaletteAction[] = [];
    if (hasPermission(PERMISSIONS.TORRENTS_ADD) && isEnabled('torrents')) {
      out.push({ id: 'add-torrent', label: t('command.action.addTorrent'), icon: Download, keywords: 'magnet upload', run: () => navigate('/torrents') });
    }
    if (canMedia) {
      out.push({ id: 'scan-library', label: t('command.action.scanLibrary'), icon: ScanSearch, keywords: 'index media', run: () => navigate('/media/libraries') });
      out.push({ id: 'find-duplicates', label: t('command.action.findDuplicates'), icon: Copy, keywords: 'duplicate cleanup', run: () => navigate('/media/duplicates') });
    }
    if (hasPermission(PERMISSIONS.RSS_VIEW) && isEnabled('rss')) {
      out.push({ id: 'rss-rule', label: t('command.action.createRssRule'), icon: Rss, keywords: 'feed subscribe', run: () => navigate('/rss') });
    }
    if (hasPermission(PERMISSIONS.AUTOMATION_VIEW) && isEnabled('automation')) {
      out.push({ id: 'automation', label: t('command.action.runAutomation'), icon: Bot, keywords: 'rule trigger', run: () => navigate('/automation') });
    }
    return out;
  }, [t, navigate, hasPermission, isEnabled, canMedia]);

  const entitySources = useMemo<PaletteEntitySource[]>(() => {
    if (!canMedia) return [];
    return [
      {
        key: 'media-items',
        title: t('command.entity.media'),
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
      },
      {
        key: 'libraries',
        title: t('command.entity.libraries'),
        search: async (q) => {
          const libs = await api.media.libraries();
          const ql = q.toLowerCase();
          return libs
            .filter((l) => l.name.toLowerCase().includes(ql) || l.path.toLowerCase().includes(ql))
            .slice(0, 6)
            .map((l) => ({ id: l.id, label: l.name, sublabel: l.path, icon: Library, to: '/media/libraries' }));
        },
      },
    ];
  }, [t, canMedia]);

  return { actions, entitySources };
}
