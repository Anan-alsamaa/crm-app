import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/preact';

// Unmount Preact trees between tests so rendered DOM from earlier tests does not
// linger (the suite runs in one process).
afterEach(() => cleanup());

// jsdom doesn't implement scrollIntoView; the widget scrolls the message list on
// new messages. Stub it so those paths don't throw.
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = () => {};
}
