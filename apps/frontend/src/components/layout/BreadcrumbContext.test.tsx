import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@/i18n';
import { Breadcrumbs } from './Breadcrumbs';
import { BreadcrumbProvider, useBreadcrumbEntity } from './BreadcrumbContext';

/** A stand-in detail page that names its entity, like MediaDetailPage does. */
function DetailPage({ path, title }: { path: string; title: string | null }) {
  useBreadcrumbEntity(path, title);
  return null;
}

function renderTrail(path: string, title: string | null) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <BreadcrumbProvider>
        <Breadcrumbs />
        <DetailPage path={path} title={title} />
      </BreadcrumbProvider>
    </MemoryRouter>,
  );
}

describe('entity-aware breadcrumbs', () => {
  it('replaces the generic Details crumb with the entity name', () => {
    renderTrail('/media/items/abc123', 'The Matrix');
    expect(screen.getByText('The Matrix')).toBeInTheDocument();
    expect(screen.queryByText('Details')).not.toBeInTheDocument();
  });

  it('falls back to Details while the entity name is not yet known', () => {
    renderTrail('/media/items/abc123', null);
    expect(screen.getByText('Details')).toBeInTheDocument();
  });

  it('ignores an entity label set for a different path', () => {
    // The provider holds a label for /media/items/xyz, but we render at .../abc.
    render(
      <MemoryRouter initialEntries={['/media/items/abc123']}>
        <BreadcrumbProvider>
          <Breadcrumbs />
          <DetailPage path="/media/items/xyz789" title="Wrong Title" />
        </BreadcrumbProvider>
      </MemoryRouter>,
    );
    expect(screen.queryByText('Wrong Title')).not.toBeInTheDocument();
    expect(screen.getByText('Details')).toBeInTheDocument();
  });
});
