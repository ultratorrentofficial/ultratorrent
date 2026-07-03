import type { ModuleStateValue, ModuleTier } from '@ultratorrent/shared';
import { Badge } from '@/components/ui/badge';

type Tone = 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'info' | 'outline';

const TIER_TONE: Record<ModuleTier, Tone> = {
  core: 'outline',
  community: 'success',
};

const TIER_LABEL: Record<ModuleTier, string> = {
  core: 'Core',
  community: 'Community',
};

export function TierBadge({ tier }: { tier: ModuleTier }) {
  return <Badge variant={TIER_TONE[tier]}>{TIER_LABEL[tier]}</Badge>;
}

const STATE_TONE: Record<ModuleStateValue, Tone> = {
  available: 'secondary',
  enabled: 'success',
  disabled: 'secondary',
  locked: 'warning',
  missing_dependency: 'warning',
  license_required: 'info',
};

const STATE_LABEL: Record<ModuleStateValue, string> = {
  available: 'Available',
  enabled: 'Enabled',
  disabled: 'Disabled',
  locked: 'Locked',
  missing_dependency: 'Missing dependency',
  license_required: 'License required',
};

export function StateBadge({ state }: { state: ModuleStateValue }) {
  return (
    <Badge variant={STATE_TONE[state]} dot>
      {STATE_LABEL[state]}
    </Badge>
  );
}

export const TIER_ORDER: ModuleTier[] = ['core', 'community'];
