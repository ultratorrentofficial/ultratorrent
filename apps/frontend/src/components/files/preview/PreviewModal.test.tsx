import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FileNode } from '@ultratorrent/shared';
import { PreviewModal } from './PreviewModal';

const apiSpy = vi.hoisted(() => ({
  preview: vi.fn(),
  mediaTicket: vi.fn(),
  streamUrl: vi.fn(),
  download: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { files: apiSpy },
}));

vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), toast: vi.fn() }),
}));

const file = (name: string, over: Partial<FileNode> = {}): FileNode => ({
  name,
  path: `/${name}`,
  isDirectory: false,
  size: 1024,
  modifiedAt: null,
  ...over,
});

function preview(over: Record<string, unknown>) {
  return {
    path: '/x',
    name: 'x',
    size: 1024,
    kind: 'text',
    mime: 'application/octet-stream',
    streamable: false,
    content: null,
    encoding: null,
    detectedEncoding: null,
    truncated: false,
    reason: null,
    ...over,
  };
}

function renderModal(node: FileNode, siblings: FileNode[] = [node], onNavigate = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <PreviewModal open node={node} siblings={siblings} canDownload onNavigate={onNavigate} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
  return { onNavigate };
}

beforeEach(() => {
  vi.clearAllMocks();
  apiSpy.mediaTicket.mockResolvedValue({
    token: 't',
    path: '/poster.jpg',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  apiSpy.streamUrl.mockImplementation(
    (t: { path: string; token: string }) =>
      `http://api.test/api/files/stream?path=${encodeURIComponent(t.path)}&ticket=${t.token}`,
  );
});

describe('PreviewModal', () => {
  it('shows an image from the ticketed stream URL rather than as text', async () => {
    apiSpy.preview.mockResolvedValue(preview({ kind: 'image', mime: 'image/jpeg', streamable: true }));
    renderModal(file('poster.jpg'));

    const img = await screen.findByAltText('poster.jpg');
    expect(img).toHaveAttribute('src', expect.stringContaining('/files/stream'));
    expect(apiSpy.mediaTicket).toHaveBeenCalledWith('/poster.jpg');
  });

  /*
   * The ticket is requested from the name, so it must not wait on the preview
   * call — that ordering is what keeps an image from opening at twice the
   * latency for no added certainty.
   */
  it('mints the ticket without waiting for the preview response', async () => {
    let resolvePreview: (value: unknown) => void = () => {};
    apiSpy.preview.mockReturnValue(new Promise((res) => { resolvePreview = res; }));
    renderModal(file('clip.mp4'));

    await waitFor(() => expect(apiSpy.mediaTicket).toHaveBeenCalledWith('/clip.mp4'));
    resolvePreview(preview({ kind: 'video', streamable: true }));
  });

  it('renders a subtitle as timed cues, not as a wall of text', async () => {
    apiSpy.preview.mockResolvedValue(
      preview({
        kind: 'subtitle',
        content: '1\n00:00:01,000 --> 00:00:03,000\nHello there.\n',
        encoding: 'utf-8',
        detectedEncoding: 'utf-8',
      }),
    );
    renderModal(file('film.en.srt'));

    expect(await screen.findByText('Hello there.')).toBeInTheDocument();
    expect(screen.getByText('00:00:01,000')).toBeInTheDocument();
    expect(screen.getByText('1 cue')).toBeInTheDocument();
  });

  it('shows the NFO text with the encoding the server reported', async () => {
    apiSpy.preview.mockResolvedValue(
      preview({ kind: 'nfo', content: '╔══╗\nGROUP\n', encoding: 'cp437', detectedEncoding: 'cp437' }),
    );
    renderModal(file('release.nfo'));

    expect(await screen.findByText('GROUP')).toBeInTheDocument();
    const encoding = screen.getByLabelText('Encoding') as HTMLSelectElement;
    expect(encoding.value).toBe('cp437');
  });

  /* Re-decoding happens on the server: the browser never has the raw bytes. */
  it('re-requests the file when a different encoding is chosen', async () => {
    apiSpy.preview.mockResolvedValue(
      preview({ kind: 'nfo', content: 'art', encoding: 'cp437', detectedEncoding: 'cp437' }),
    );
    renderModal(file('release.nfo'));
    await screen.findByText('art');

    fireEvent.change(screen.getByLabelText('Encoding'), { target: { value: 'latin1' } });
    await waitFor(() => expect(apiSpy.preview).toHaveBeenCalledWith('/release.nfo', 'latin1'));
  });

  it('offers the download instead of an error when there is nothing to show', async () => {
    apiSpy.preview.mockResolvedValue(preview({ kind: 'archive', reason: 'Archives cannot be previewed' }));
    renderModal(file('pack.zip'));

    expect(await screen.findByText('Archives cannot be previewed')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Download' }).length).toBeGreaterThan(0);
  });

  /*
   * Stepping through a folder should stop only on things worth looking at —
   * pausing on a ZIP to say it cannot be previewed is not navigation.
   */
  it('skips archives and binaries when paging to the next file', async () => {
    apiSpy.preview.mockResolvedValue(preview({ kind: 'image', streamable: true, mime: 'image/png' }));
    const siblings = [file('a.png'), file('pack.zip'), file('b.png')];
    const { onNavigate } = renderModal(siblings[0], siblings);

    fireEvent.click(await screen.findByLabelText('Next file'));
    expect(onNavigate).toHaveBeenCalledWith(siblings[2]);
  });

  it('has no previous file at the start of the folder', async () => {
    apiSpy.preview.mockResolvedValue(preview({ kind: 'image', streamable: true, mime: 'image/png' }));
    const siblings = [file('a.png'), file('b.png')];
    renderModal(siblings[0], siblings);

    expect(await screen.findByLabelText('Previous file')).toBeDisabled();
    expect(screen.getByLabelText('Next file')).toBeEnabled();
  });

  it('reports a failed ticket without pretending the file is unreadable', async () => {
    apiSpy.preview.mockResolvedValue(preview({ kind: 'image', streamable: true, mime: 'image/png' }));
    apiSpy.mediaTicket.mockRejectedValue(new Error('nope'));
    renderModal(file('poster.png'));

    expect(await screen.findByText('Could not open this file for streaming.')).toBeInTheDocument();
  });
});
