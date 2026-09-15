import type { BadgeVariant } from '@/components/ui/badge';
import type { MediaFindingSeverity, MediaHealthStatus } from '@ultratorrent/shared';

/**
 * Health and severity rendered through the design system's existing variants.
 *
 * `degraded` and `critical` deliberately share `destructive`: the palette has
 * one "this is bad" colour, and inventing a second would put a shade on screen
 * that appears nowhere else in the product. The two stay distinguishable by
 * their label and by list ordering, not by an off-system colour.
 */
export const HEALTH_VARIANT: Record<MediaHealthStatus, BadgeVariant> = {
  healthy: 'success',
  attention: 'warning',
  degraded: 'destructive',
  critical: 'destructive',
  // Not a failure state — "we have never looked" is honestly neutral.
  unknown: 'outline',
};

export const SEVERITY_VARIANT: Record<MediaFindingSeverity, BadgeVariant> = {
  info: 'secondary',
  opportunity: 'info',
  warning: 'warning',
  error: 'destructive',
  critical: 'destructive',
};

/** Worst first. Used wherever findings or health are listed. */
export const HEALTH_ORDER: MediaHealthStatus[] = ['critical', 'degraded', 'attention', 'unknown', 'healthy'];
export const SEVERITY_ORDER: MediaFindingSeverity[] = ['critical', 'error', 'warning', 'opportunity', 'info'];

/** A fact section's status badge. `partial` is its own answer, not a near-miss. */
export const FACT_STATUS_VARIANT: Record<'known' | 'partial' | 'unknown', BadgeVariant> = {
  known: 'success',
  partial: 'warning',
  unknown: 'outline',
};
