import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmount React trees between tests. Required when the whole suite runs in one
// process (single-fork pool): without it, rendered DOM from earlier tests
// lingers and `getByText`/`getByTestId` find duplicate matches.
afterEach(() => cleanup());
