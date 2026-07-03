import { useModules } from './ModuleContext';

/** Boolean feature-gate hook: is the given module enabled for this user? */
export function useHasModule(id: string): boolean {
  return useModules().hasModule(id);
}
