import { useTranslation } from 'react-i18next';
import type { ModuleStateValue } from '@ultratorrent/shared';
import { Badge } from '@/components/ui/badge';

type Tone = 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'info' | 'outline';

/**
 * Says a module cannot be switched off — not which edition it belongs to.
 *
 * This was a tier badge reading "Core" or "Community", labels for a two-edition
 * product that no longer exists: everything ships in the one community build.
 * What it was really communicating, for the "Core" half, is that the module is
 * load-bearing and the toggle will refuse.
 */
export function RequiredBadge() {
  const { t } = useTranslation('modules');
  return <Badge variant="outline">{t('required')}</Badge>;
}

const STATE_TONE: Record<ModuleStateValue, Tone> = {
  available: 'secondary',
  enabled: 'success',
  disabled: 'secondary',
  locked: 'warning',
  missing_dependency: 'warning',
  license_required: 'info',
};

export function StateBadge({ state }: { state: ModuleStateValue }) {
  const { t } = useTranslation('modules');
  return (
    <Badge variant={STATE_TONE[state]} dot>
      {t(`state.${state}`)}
    </Badge>
  );
}

