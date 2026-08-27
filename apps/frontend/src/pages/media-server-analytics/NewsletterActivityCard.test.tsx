import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { mediaServerAnalytics: { newsletterActivity: vi.fn() } },
}));

import { api } from '@/lib/api';
import { NewsletterActivityCard } from './NewsletterActivityCard';

const event = (over: Record<string, unknown> = {}) => ({
  id: 'e1', newsletterId: 'n1', runId: 'run1', level: 'info', eventType: 'generated',
  messageKey: null, messageParams: null, sanitizedMessage: null, metadata: null,
  createdAt: '2026-08-27T01:00:00Z', ...over,
});

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NewsletterActivityCard />
    </QueryClientProvider>,
  );
}

describe('NewsletterActivityCard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('summarises a send and opens to the run', async () => {
    vi.mocked(api.mediaServerAnalytics.newsletterActivity).mockResolvedValue([
      {
        ...event({
          id: 'head', eventType: 'send_completed', level: 'success',
          messageKey: 'newsletter.event.sendCompleted',
          messageParams: { sent: 2, failed: 1 },
          metadata: { subject: 'This week', sent: 2, failed: 1, recipients: 3 },
        }),
        events: [
          event({ id: 'a', eventType: 'generated', messageKey: 'newsletter.event.generated', messageParams: { items: 12 } }),
          event({ id: 'b', eventType: 'recipient_failed', level: 'error',
                  messageKey: 'newsletter.event.recipientFailed',
                  messageParams: { recipient: 'nope@example.com' },
                  sanitizedMessage: 'mailbox unavailable' }),
        ],
      },
    ] as never);

    renderCard();
    await waitFor(() => expect(screen.getByText(/2 delivered, 1 failed/i)).toBeTruthy());

    // Collapsed: the run's events are not on screen yet.
    expect(screen.queryByText(/mailbox unavailable/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { expanded: false }));

    // Expanded: the detail an admin came for.
    await waitFor(() => expect(screen.getByText(/mailbox unavailable/i)).toBeTruthy());
    expect(screen.getByText(/Could not deliver to nope@example.com/i)).toBeTruthy();
    expect(screen.getByText('This week')).toBeTruthy();
  });

  /*
   * The event this feature existed to surface: a scheduled send that failed
   * before a run began. It has no sub-events, and must still open to its reason.
   */
  it('opens a standalone failure to its reason', async () => {
    vi.mocked(api.mediaServerAnalytics.newsletterActivity).mockResolvedValue([
      {
        ...event({
          id: 'sched', runId: null, eventType: 'send_failed', level: 'error',
          messageKey: 'newsletter.event.scheduledFailed',
          sanitizedMessage: 'SMTP connect timeout',
          metadata: { trigger: 'scheduled', name: 'Weekly digest' },
        }),
        events: [],
      },
    ] as never);

    renderCard();
    await waitFor(() => expect(screen.getByText(/Scheduled send failed/i)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    await waitFor(() => expect(screen.getByText(/SMTP connect timeout/i)).toBeTruthy());
    expect(screen.getByText('Weekly digest')).toBeTruthy();
  });

  it('says so when nothing has been recorded', async () => {
    vi.mocked(api.mediaServerAnalytics.newsletterActivity).mockResolvedValue([] as never);
    renderCard();
    await waitFor(() => expect(screen.getByText(/Nothing recorded yet/i)).toBeTruthy());
  });

  /* An event type this build does not know must still render as something. */
  it('renders an unknown event type rather than a blank line', async () => {
    vi.mocked(api.mediaServerAnalytics.newsletterActivity).mockResolvedValue([
      { ...event({ id: 'x', eventType: 'invented_later', messageKey: null }), events: [] },
    ] as never);
    renderCard();
    await waitFor(() => expect(screen.getByText('invented_later')).toBeTruthy());
  });
});
