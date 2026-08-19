import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
// Initialize i18next once for the whole suite so components that call
// `useTranslation()` render their en-US strings (no provider wrapping needed).
import '@/i18n';

/*
 * jsdom implements no ResizeObserver, and a component that measures itself (the
 * image viewer, which recomputes what "fit" means when its box changes) throws
 * on mount without one. The stub observes nothing — layout in jsdom is zero-sized
 * anyway — it exists so mounting such a component is not an error.
 */
if (!('ResizeObserver' in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Unmount React trees between tests so DOM assertions don't leak across cases.
afterEach(() => {
  cleanup();
});
