import { useModules } from './ModuleContext';
import { LockedModulePage } from './LockedModulePage';
import { CenteredSpinner } from '@/components/ui/feedback';

/**
 * Gates a route's element behind an enabled module. While the enabled-modules
 * query is loading we show a spinner; once resolved, a disabled module renders
 * the friendly locked page instead of the feature UI.
 */
export function ModuleRoute({
  moduleId,
  children,
}: {
  moduleId: string;
  children: React.ReactNode;
}) {
  const { isEnabled, isLoading } = useModules();
  if (isLoading) return <CenteredSpinner label="Loading…" />;
  if (!isEnabled(moduleId)) return <LockedModulePage moduleId={moduleId} />;
  return <>{children}</>;
}
