import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Boxes, FolderTree, ScanSearch } from 'lucide-react';
import '@/i18n';
import type { NavGroup } from './navigation';
import type { JobSummary } from '@/lib/api';

const scanRun = vi.fn();
vi.mock('./usePaletteProviders', () => ({
  usePaletteProviders: () => ({
    actions: [
      { id: 'scan-library', label: 'Scan library', icon: ScanSearch, run: scanRun },
      { id: 'find-duplicates', label: 'Find duplicates', icon: ScanSearch, run: vi.fn() },
    ],
    entitySources: [],
  }),
}));

let mockJobs: JobSummary[] = [];
vi.mock('./useWorkspaceJobs', () => ({
  useWorkspaceJobs: () => ({ jobs: mockJobs, isLoading: false, isError: false }),
}));

const { WorkspaceOverview } = await import('./WorkspaceOverview');

const mediaGroup: NavGroup = {
  id: 'media',
  title: 'Media',
  icon: Boxes,
  items: [{ id: 'media-dashboard', to: '/media', label: 'Media Dashboard', icon: Boxes }],
};
const filesGroup: NavGroup = {
  id: 'files',
  title: 'Files',
  icon: FolderTree,
  items: [{ id: 'files', to: '/files', label: 'File Manager', icon: FolderTree }],
};

function renderOverview(group: NavGroup) {
  return render(
    <MemoryRouter>
      <WorkspaceOverview group={group} />
    </MemoryRouter>,
  );
}

describe('WorkspaceOverview', () => {
  it('renders the workspace’s quick actions and runs one on click', () => {
    mockJobs = [];
    renderOverview(mediaGroup);
    const scan = screen.getByRole('button', { name: 'Scan library' });
    expect(scan).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Find duplicates' })).toBeInTheDocument();
    fireEvent.click(scan);
    expect(scanRun).toHaveBeenCalledTimes(1);
  });

  it('shows the active-jobs widget with jobs for a job-bearing workspace', () => {
    mockJobs = [
      { id: 'j1', subsystem: 'media', type: 'library_scan', status: 'running', progress: 42, label: 'Movies', error: null, createdAt: '', updatedAt: '' },
    ];
    renderOverview(mediaGroup);
    expect(screen.getByText('Active jobs')).toBeInTheDocument();
    expect(screen.getByText('library_scan')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  it('shows an empty state when a job-bearing workspace has no active jobs', () => {
    mockJobs = [];
    renderOverview(mediaGroup);
    expect(screen.getByText('No active jobs.')).toBeInTheDocument();
  });

  it('renders neither quick actions nor a jobs widget for a workspace without config', () => {
    mockJobs = [];
    renderOverview(filesGroup);
    expect(screen.queryByText('Active jobs')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Scan library' })).not.toBeInTheDocument();
  });
});
