import { useTranslation } from 'react-i18next';
import type { ModuleStateValue, ModuleTier } from '@ultratorrent/shared';
import { Badge } from '@/components/ui/badge';

type Tone = 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'info' | 'outline';

const TIER_TONE: Record<ModuleTier, Tone> = {
  core: 'outline',
  community: 'success',
};

export function TierBadge({ tier }: { tier: ModuleTier }) {
  const { t } = useTranslation('modules');
  return <Badge variant={TIER_TONE[tier]}>{t(`tier.${tier}`)}</Badge>;
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

export const TIER_ORDER: ModuleTier[] = ['core', 'community'];
