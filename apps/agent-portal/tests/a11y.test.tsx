import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import axe from 'axe-core';
import { Button, EmptyState, ShortcutsOverlay, UsersIcon } from '@yiji/ui';

/**
 * Accessibility smoke test for the shared UI primitives that don't need app
 * providers. Runs axe-core against the rendered DOM and fails on any serious
 * or critical violation. Route-level axe coverage lives in the E2E suite
 * (Stream C); this guards the design-system primitives in unit CI.
 */
async function expectNoViolations(container: HTMLElement) {
  const results = await axe.run(container, {
    // jsdom can't compute layout, so color-contrast is not meaningful here.
    rules: { 'color-contrast': { enabled: false } },
  });
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

afterEach(() => cleanup());

describe('UI primitives accessibility', () => {
  it('EmptyState has no serious axe violations', async () => {
    const { container } = render(
      <main>
        <EmptyState
          icon={<UsersIcon size={40} />}
          title="No contacts yet"
          description="Contacts appear automatically as customers reach out."
          action={<Button type="button">Create contact</Button>}
        />
      </main>,
    );
    await expectNoViolations(container);
  });

  it('ShortcutsOverlay has no serious axe violations', async () => {
    const { container } = render(
      <ShortcutsOverlay
        open
        onClose={() => {}}
        title="Keyboard shortcuts"
        closeLabel="Close"
        groups={[
          {
            heading: 'Navigation',
            items: [
              { keys: ['g', 'i'], label: 'Inbox' },
              { keys: ['g', 't'], label: 'Tickets' },
            ],
          },
          {
            heading: 'General',
            items: [{ keys: ['?'], label: 'Show this help' }],
          },
        ]}
      />,
    );
    await expectNoViolations(container);
  });
});
