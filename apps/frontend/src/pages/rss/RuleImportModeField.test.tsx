import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@/i18n';

const profilesQuery = vi.hoisted(() => ({ value: { data: [], isSuccess: true } as unknown }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => profilesQuery.value }));
vi.mock('@/lib/api', () => ({ api: { intake: { profiles: vi.fn() } } }));

import { RuleImportModeField } from './RuleImportModeField';

const renderField = (props: Partial<Parameters<typeof RuleImportModeField>[0]> = {}) =>
  render(
    <MemoryRouter>
      <RuleImportModeField
        value="managed_intake"
        profileId={null}
        onChange={vi.fn()}
        onProfileChange={vi.fn()}
        {...props}
      />
    </MemoryRouter>,
  );

beforeEach(() => {
  profilesQuery.value = { data: [{ id: 'p1', name: 'Synoplex' }], isSuccess: true };
});

describe('RuleImportModeField', () => {
  it('explains what each mode actually does', () => {
    /*
     * "Legacy Direct" and "Managed Intake" are two words a reader has to guess
     * between. The consequence — where files land, whether seeding survives —
     * is the thing being chosen, so it is what the field describes.
     */
    renderField({ value: 'managed_intake' });
    expect(screen.getByText(/staged, verified, identified/)).toBeInTheDocument();

    renderField({ value: 'legacy_direct' });
    expect(screen.getByText(/original behaviour, unchanged/)).toBeInTheDocument();
  });

  it('offers a storage profile only for a managed rule', () => {
    renderField({ value: 'legacy_direct' });
    expect(screen.queryByLabelText(/Storage profile/)).not.toBeInTheDocument();

    renderField({ value: 'managed_intake' });
    expect(screen.getByLabelText(/Storage profile/)).toBeInTheDocument();
  });

  it('WARNS when managed is chosen with no profile to stage into', () => {
    /*
     * The failure this prevents: a rule marked managed with nowhere to stage
     * imports nothing at all and only says so in a log line. "Enabled but
     * inert" has caught this project out twice — the IMDb schedule and the
     * timezone rollout.
     */
    profilesQuery.value = { data: [], isSuccess: true };
    renderField({ value: 'managed_intake' });
    expect(screen.getByText(/would import nothing/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Create one/ })).toBeInTheDocument();
  });

  it('does not warn when a profile exists', () => {
    renderField({ value: 'managed_intake' });
    expect(screen.queryByText(/would import nothing/)).not.toBeInTheDocument();
  });

  it('reports a mode change', () => {
    const onChange = vi.fn();
    renderField({ onChange });
    fireEvent.change(screen.getByLabelText(/Import mode/), { target: { value: 'legacy_direct' } });
    expect(onChange).toHaveBeenCalledWith('legacy_direct');
  });

  it('reports a profile choice, and null for the default', () => {
    const onProfileChange = vi.fn();
    renderField({ onProfileChange });
    const select = screen.getByLabelText(/Storage profile/);
    fireEvent.change(select, { target: { value: 'p1' } });
    expect(onProfileChange).toHaveBeenCalledWith('p1');
    fireEvent.change(select, { target: { value: '' } });
    // Empty means "use the default", which is null on the wire — not "".
    expect(onProfileChange).toHaveBeenCalledWith(null);
  });

  it('disables the profile picker when there is nothing to pick', () => {
    profilesQuery.value = { data: [], isSuccess: true };
    renderField({ value: 'managed_intake' });
    expect(screen.getByLabelText(/Storage profile/)).toBeDisabled();
  });
});
