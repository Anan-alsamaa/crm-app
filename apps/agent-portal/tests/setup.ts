import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom doesn't implement Element.scrollIntoView, but SelectMenu (and other
// dropdowns) call it on open. Stub it so dropdown-opening tests don't throw.
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = () => {};
}

// Unmount React trees between tests. Required when the whole suite runs in one
// process (single-fork pool): without it, rendered DOM from earlier tests
// lingers and `getByText`/`getByTestId` find duplicate matches.
afterEach(() => cleanup());
