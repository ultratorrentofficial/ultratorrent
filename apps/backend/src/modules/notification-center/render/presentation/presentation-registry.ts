import type { NotificationPresentation } from '@ultratorrent/shared';
import type { PresentationBuilder, PresentationContext } from './presentation.types';
import { PLAYBACK_PRESENTATION_BUILDERS } from './playback.builder';

/**
 * Event key → rich-presentation builder.
 *
 * A registry rather than a switch so an event opts *in* by registering. Most of
 * the 70 catalogue events do not deserve a poster and a fact table — a disk-space
 * warning is a sentence — and the unregistered majority keep the plain title/body
 * rendering. This also keeps each builder's copy and payload knowledge in its own
 * file instead of accumulating in one function.
 */
const BUILDERS: Record<string, PresentationBuilder> = {
  ...PLAYBACK_PRESENTATION_BUILDERS,
};

/** Whether an event renders as a rich card. Used to skip pointless work. */
export function hasPresentation(eventKey: string): boolean {
  return eventKey in BUILDERS;
}

/** Event keys with a rich presentation — for docs, tests and the preview picker. */
export function presentableEventKeys(): string[] {
  return Object.keys(BUILDERS).sort();
}

/**
 * Build the presentation for one event and recipient, or null if there is none.
 *
 * A builder that throws is contained here. A malformed payload must degrade the
 * card to plain text, never fail the dispatch — losing a notification entirely
 * because its poster could not be resolved is a far worse outcome than an
 * unstyled one.
 */
export function buildPresentation(ctx: PresentationContext): NotificationPresentation | null {
  const builder = BUILDERS[ctx.eventKey];
  if (!builder) return null;
  try {
    return builder(ctx);
  } catch {
    return null;
  }
}
