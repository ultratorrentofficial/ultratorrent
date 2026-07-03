import type { ModuleStatus } from '@ultratorrent/shared';
import { useModules } from './ModuleContext';

/** Returns the enabled-ModuleStatus for an id, or undefined if not enabled/visible. */
export function useModule(id: string): ModuleStatus | undefined {
  const { modules } = useModules();
  return modules.find((m) => m.id === id);
}
