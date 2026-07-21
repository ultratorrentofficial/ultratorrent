import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * Lets a detail page name the entity it's showing so the breadcrumb trail can end
 * with e.g. "The Matrix" instead of a generic "Details". The page calls
 * {@link useBreadcrumbEntity} with the loaded entity's name; the shell reads the
 * current value when rendering the trail. The label is keyed by pathname so a
 * stale value from a previous page never leaks onto the next one.
 */
interface BreadcrumbEntity {
  path: string;
  label: string;
}

interface BreadcrumbCtx {
  entity: BreadcrumbEntity | null;
  setEntity: (e: BreadcrumbEntity | null) => void;
}

const Ctx = createContext<BreadcrumbCtx | null>(null);

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  const [entity, setEntity] = useState<BreadcrumbEntity | null>(null);
  return <Ctx.Provider value={{ entity, setEntity }}>{children}</Ctx.Provider>;
}

/**
 * Read the current entity label for a pathname (used by the breadcrumb bar).
 * Returns null when there's no provider (e.g. in isolated tests) or the stored
 * label belongs to a different path.
 */
export function useBreadcrumbEntityLabel(pathname: string): string | null {
  const ctx = useContext(Ctx);
  if (!ctx?.entity) return null;
  return ctx.entity.path === pathname ? ctx.entity.label : null;
}

/**
 * Set the trailing breadcrumb label for the current detail page. Pass the loaded
 * entity's display name (or `null`/`undefined` while loading). No-ops without a
 * provider, so pages can call it unconditionally. Clears on unmount.
 */
export function useBreadcrumbEntity(pathname: string, label: string | null | undefined): void {
  const ctx = useContext(Ctx);
  const setEntity = ctx?.setEntity;
  useEffect(() => {
    if (!setEntity) return;
    if (label) setEntity({ path: pathname, label });
    return () => setEntity(null);
  }, [setEntity, pathname, label]);
}
