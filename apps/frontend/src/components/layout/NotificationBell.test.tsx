import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { NotificationPresentation } from '@ultratorrent/shared';
import type { InboxItem } from '@/lib/api';
import { NotificationBell } from './NotificationBell';

const navigate = vi.fn();
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual<typeof import('react-router-dom')>('react-router-dom')),
  useNavigate: () => navigate,
}));

// The socket is infrastructure here: the component only needs `on()` to return an
// unsubscribe, and a real client would try to open a connection under test.
vi.mock('@/lib/ws', () => ({ wsClient: { on: () => () => undefined } }));

const unreadCount = vi.fn();
const inbox = vi.fn();
const markRead = vi.fn();
const markAllRead = vi.fn();
vi.mock('@/lib/api', () => ({
  api: {
    account: {
      notifications: {
        unreadCount: () => unreadCount(),
        inbox: (q: Record<string, string>) => inbox(q),
        markRead: (id: string, read: boolean) => markRead(id, read),
        markAllRead: () => markAllRead(),
      },
    },
  },
}));

const presentation: NotificationPresentation = {
  version: 1,
  eventKey: 'media_server.user_started_watching',
  accent: 'positive',
  icon: 'play',
  eyebrow: 'ULTRATORRENT',
  headline: { lead: 'User Started', trail: 'Watching' },
  summary: { text: 'Dennis started watching Dune (2021)', emphasis: 'Dune (2021)' },
  avatar: { initials: 'D', hue: 200, label: 'Dennis' },
  artwork: null,
  facts: [{ icon: 'clock', label: 'Time', value: 'Today, 8:24 PM' }],
  progress: null,
  status: 'Now playing',
  action: { label: 'View details', href: '/media-server/live', icon: 'monitor' },
  timestamp: new Date().toISOString(),
};

function item(over: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'n1', eventKey: 'media_server.user_started_watching', category: 'media_server',
    severity: 'info', title: 'Dennis started watching Dune (2021)', body: null,
    deepLink: '/media-server/live', read: false, archived: false, groupCount: 1,
    lastAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    deliveries: [], presentation,
    ...over,
  } as InboxItem;
}

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <NotificationBell />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  unreadCount.mockResolvedValue({ unread: 3 });
  inbox.mockResolvedValue({ items: [item()], total: 1, page: 1, pageSize: 8 });
  markRead.mockResolvedValue({ id: 'n1', read: true });
  markAllRead.mockResolvedValue({ updated: 3 });
});

describe('NotificationBell', () => {
  it('shows the unread count and announces it', async () => {
    setup();
    expect(await screen.findByText('3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /3 unread notifications/i })).toBeInTheDocument();
  });

  it('caps a large badge but keeps the true count in the label', async () => {
    unreadCount.mockResolvedValue({ unread: 250 });
    setup();
    expect(await screen.findByText('99+')).toBeInTheDocument();
    // The badge truncates; the accessible name must not lie about how many.
    expect(screen.getByRole('button', { name: /250 unread notifications/i })).toBeInTheDocument();
  });

  it('does not fetch the list until the panel is opened', async () => {
    setup();
    await screen.findByText('3');
    expect(inbox).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /unread notifications/i }));
    await waitFor(() => expect(inbox).toHaveBeenCalledTimes(1));
  });

  it('renders the compact rich card, without the fact table or action button', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: /unread notifications/i }));

    expect(await screen.findByText(/started watching/)).toBeInTheDocument();
    expect(screen.getByText('Dune (2021)')).toBeInTheDocument();
    // Compact drops these — the panel row itself is the action.
    expect(screen.queryByText('View details')).not.toBeInTheDocument();
    expect(screen.queryByText('User Started')).not.toBeInTheDocument();
  });

  it('marks read and navigates to the deep link when a row is opened', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: /unread notifications/i }));
    fireEvent.click(await screen.findByText(/started watching/));

    expect(markRead).toHaveBeenCalledWith('n1', true);
    expect(navigate).toHaveBeenCalledWith('/media-server/live');
  });

  it('falls back to the inbox when a notification has no deep link', async () => {
    inbox.mockResolvedValue({ items: [item({ deepLink: null })], total: 1, page: 1, pageSize: 8 });
    setup();
    fireEvent.click(await screen.findByRole('button', { name: /unread notifications/i }));
    fireEvent.click(await screen.findByText(/started watching/));

    expect(navigate).toHaveBeenCalledWith('/account/notifications/inbox');
  });

  it('does not re-mark an already-read notification', async () => {
    inbox.mockResolvedValue({ items: [item({ read: true })], total: 1, page: 1, pageSize: 8 });
    setup();
    fireEvent.click(await screen.findByRole('button', { name: /unread notifications/i }));
    fireEvent.click(await screen.findByText(/started watching/));

    expect(markRead).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalled();
  });

  it('renders a plain row for a notification with no presentation', async () => {
    inbox.mockResolvedValue({
      items: [item({ presentation: null, title: 'Low disk space' })],
      total: 1, page: 1, pageSize: 8,
    });
    setup();
    fireEvent.click(await screen.findByRole('button', { name: /unread notifications/i }));
    expect(await screen.findByText('Low disk space')).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: /unread notifications/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('marks everything read from the panel header', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: /unread notifications/i }));
    fireEvent.click(await screen.findByRole('button', { name: /mark all read/i }));
    await waitFor(() => expect(markAllRead).toHaveBeenCalledTimes(1));
  });

  it('shows an error line rather than an empty panel when the list fails', async () => {
    inbox.mockRejectedValue(new Error('boom'));
    setup();
    fireEvent.click(await screen.findByRole('button', { name: /unread notifications/i }));
    expect(await screen.findByText(/could not load notifications/i)).toBeInTheDocument();
  });

  it('keeps the shell intact when the unread count fails', async () => {
    unreadCount.mockRejectedValue(new Error('boom'));
    setup();
    // No badge, but the bell still renders and still opens.
    expect(await screen.findByRole('button', { name: /no unread notifications/i })).toBeInTheDocument();
  });
});
