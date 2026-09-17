import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown> & { defaultValue?: string }) =>
      String(o?.defaultValue ?? k),
  }),
}));

import { ReportFilterBar } from '../src/components/ReportFilterBar.js';

// jsdom has no layout, so SelectMenu's keep-the-active-option-in-view call
// throws. Stub it rather than let an unrelated gap fail the assertion.
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = () => {};
}

/*
 * CHOOSING A FILTER APPLIES IT. NO Apply CLICK (owner, 2026-09-17).
 *
 * The bar deliberately holds a DRAFT for typed fields: re-querying on every
 * keystroke made the table move under the hands of somebody still deciding
 * what to ask. A dropdown is not that — it is one deliberate act with a
 * settled value — so it must take effect on its own.
 */
function Harness() {
  const [brand, setBrand] = useState('');
  const [search, setSearch] = useState('');
  return (
    <>
      <ReportFilterBar
        searchLabel="Search"
        searchPlaceholder="Search…"
        search={search}
        onSearch={setSearch}
        from=""
        to=""
        onFrom={() => {}}
        onTo={() => {}}
        selects={[
          {
            key: 'brand',
            label: 'Brand',
            value: brand,
            onChange: setBrand,
            options: [
              { value: 'b1', label: 'Brand One' },
              { value: 'b2', label: 'Brand Two' },
            ],
          },
        ]}
        filtering={Boolean(brand || search)}
        onClear={() => {
          setBrand('');
          setSearch('');
        }}
      />
      <output data-testid="applied-brand">{brand}</output>
      <output data-testid="applied-search">{search}</output>
    </>
  );
}

/** SelectMenu is a custom combobox, not a native <select>: open it, then
 *  click the option the way a person does. */
async function choose(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(screen.getByRole('combobox', { name: label }));
  // `role="option"` sits on the <li>; the click handler is on the <button>
  // inside it, so clicking the li alone does nothing.
  const li = await screen.findByRole('option', { name: option });
  await user.click(within(li).getByRole('button'));
}

describe('ReportFilterBar — a dropdown applies itself', () => {
  it('pushes a chosen value up WITHOUT an Apply click', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await choose(user, 'Brand', 'Brand Two');

    expect(screen.getByTestId('applied-brand')).toHaveTextContent('b2');
  });

  /* The draft exists for typing, and must survive a select rather than being
     silently discarded by it. */
  it('carries a typed-but-unapplied value along with the select', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(screen.getByPlaceholderText('Search…'), 'pizza');
    // Still only a draft — typing does not query.
    expect(screen.getByTestId('applied-search')).toHaveTextContent('');

    await choose(user, 'Brand', 'Brand One');
    expect(screen.getByTestId('applied-brand')).toHaveTextContent('b1');
    expect(screen.getByTestId('applied-search')).toHaveTextContent('pizza');
  });

  /*
   * The button is now a signal, not furniture. Permanently-disabled made sense
   * while every control needed it; with dropdowns applying themselves it would
   * be the normal state — a dead control implying the table has not caught up.
   */
  it('shows no Apply button when nothing is waiting', () => {
    render(<Harness />);
    expect(screen.queryByRole('button', { name: /Apply/i })).not.toBeInTheDocument();
  });

  it('shows Apply only once something is typed', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByRole('button', { name: /Apply/i })).not.toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Search…'), 'x');
    expect(screen.getByRole('button', { name: /Apply/i })).toBeInTheDocument();
  });

  it('hides Apply again once the draft is applied', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByPlaceholderText('Search…'), 'pizza');
    await user.click(screen.getByRole('button', { name: /Apply/i }));

    expect(screen.getByTestId('applied-search')).toHaveTextContent('pizza');
    expect(screen.queryByRole('button', { name: /Apply/i })).not.toBeInTheDocument();
  });

  it('still waits for Apply on a typed value alone', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(screen.getByPlaceholderText('Search…'), 'burger');
    expect(screen.getByTestId('applied-search')).toHaveTextContent('');
  });
});
