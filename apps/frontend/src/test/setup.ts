import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
// Initialize i18next once for the whole suite so components that call
// `useTranslation()` render their en-US strings (no provider wrapping needed).
import '@/i18n';

// Unmount React trees between tests so DOM assertions don't leak across cases.
afterEach(() => {
  cleanup();
});
