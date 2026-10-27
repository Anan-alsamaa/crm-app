import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';
import { useState } from 'react';
import {
  FormField,
  MultiSelectMenu,
  Select,
  SelectMenu,
  matchesQuery,
  normalizeSearchText,
} from '@yiji/ui';

/*
 * Every dropdown is type-to-filter (owner, 2026-10-26): open it, type, and only
 * the matching options stay under the box.
 */

afterEach(() => {
  cleanup();
  document.documentElement.lang = '';
});
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const AGENTS = [
  { value: '', label: 'All agents' },
  { value: 'a1', label: 'Ahmed Saleh' },
  { value: 'a2', label: 'Sara Ali' },
  { value: 'a3', label: 'أحمد الزهراني' },
  { value: 'a4', label: 'Khalid Othman' },
];

function Harness({
  onPick,
  options = AGENTS,
}: {
  onPick?: (v: string) => void;
  options?: typeof AGENTS;
}) {
  const [value, setValue] = useState('');
  return (
    <SelectMenu
      aria-label="Agent"
      value={value}
      onChange={(v) => {
        setValue(v);
        onPick?.(v);
      }}
      options={options}
    />
  );
}

const optionNames = () => screen.getAllByRole('option').map((o) => o.textContent);
const searchBox = () => screen.getByRole('combobox', { name: 'Search options' });

describe('normalizeSearchText / matchesQuery', () => {
  it('matches anywhere, case-insensitively, ignoring Latin accents', () => {
    expect(matchesQuery('LCP-053 Othaim Mall Khurais Road', 'khurais')).toBe(true);
    expect(matchesQuery('Café Nero', 'cafe')).toBe(true);
    expect(matchesQuery('Sara Ali', 'zz')).toBe(false);
    expect(matchesQuery('anything', '   ')).toBe(true);
  });

  it('ignores Arabic harakat, tatweel and alef/ya/ta-marbuta variants', () => {
    expect(matchesQuery('أحمد', 'احمد')).toBe(true);
    expect(matchesQuery('مطـــعم', 'مطعم')).toBe(true);
    expect(matchesQuery('مُحَمَّد', 'محمد')).toBe(true);
    expect(matchesQuery('مستشفى', 'مستشفي')).toBe(true);
    expect(matchesQuery('مدرسة', 'مدرسه')).toBe(true);
    expect(normalizeSearchText('  Ahmed   SALEH ')).toBe('ahmed saleh');
  });
});

describe('SelectMenu — type to filter', () => {
  it('shows a search box when opened and filters the options as you type', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Agent' }));
    expect(optionNames()).toHaveLength(5);

    fireEvent.change(searchBox(), { target: { value: 'ali' } });
    // "Sara Ali" and "Khalid" (k-h-A-L-I-d): match anywhere, not only the start.
    expect(optionNames()).toEqual(['Sara Ali', 'Khalid Othman']);
  });

  it('finds an Arabic name typed without the hamza', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Agent' }));
    fireEvent.change(searchBox(), { target: { value: 'احمد' } });
    expect(optionNames()).toEqual(['أحمد الزهراني']);
  });

  it('moves through the filtered options with the arrows and picks with Enter', () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    const trigger = screen.getByRole('combobox', { name: 'Agent' });
    fireEvent.click(trigger);
    const box = searchBox();
    fireEvent.change(box, { target: { value: 'a' } });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    // The active row is announced through aria-activedescendant.
    const activeId = box.getAttribute('aria-activedescendant');
    expect(activeId).toBeTruthy();
    expect(document.getElementById(activeId!)?.textContent).toBe('Ahmed Saleh');

    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('a1');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it('Escape closes, clears the search and returns focus to the trigger', () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    const trigger = screen.getByRole('combobox', { name: 'Agent' });
    fireEvent.click(trigger);
    fireEvent.change(searchBox(), { target: { value: 'sara' } });
    fireEvent.keyDown(searchBox(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
    expect(onPick).not.toHaveBeenCalled();

    // Reopening starts from the full list.
    fireEvent.click(trigger);
    expect(optionNames()).toHaveLength(5);
    expect(searchBox()).toHaveValue('');
  });

  it('says so when nothing matches (EN and AR)', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Agent' }));
    fireEvent.change(searchBox(), { target: { value: 'zzz' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No matches')).toBeInTheDocument();
    cleanup();

    document.documentElement.lang = 'ar';
    render(<Harness />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Agent' }));
    const box = screen.getByRole('combobox', { name: 'ابحث في الخيارات' });
    expect(box).toHaveAttribute('placeholder', 'اكتب للبحث…');
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(screen.getByText('لا توجد نتائج مطابقة')).toBeInTheDocument();
  });

  it('typing on the closed trigger opens it with those letters in the box', async () => {
    vi.useFakeTimers();
    try {
      render(<Harness />);
      const trigger = screen.getByRole('combobox', { name: 'Agent' });
      trigger.focus();
      fireEvent.keyDown(trigger, { key: 'k' });
      expect(searchBox()).toHaveValue('k');
      await act(async () => {
        vi.runAllTimers();
      });
      expect(document.activeElement).toBe(searchBox());
      expect(optionNames()).toEqual(['Khalid Othman']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a two-option menu a plain pick-list', () => {
    render(
      <Harness
        options={[
          { value: 'en', label: 'EN' },
          { value: 'ar', label: 'AR' },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Agent' }));
    expect(screen.queryByRole('combobox', { name: 'Search options' })).not.toBeInTheDocument();
    expect(optionNames()).toEqual(['EN', 'AR']);
  });
});

describe('Select (form select) — same menu, native select underneath', () => {
  function FormHarness({ onChange }: { onChange: (v: string) => void }) {
    const [v, setV] = useState('');
    return (
      <FormField label="Category">
        <Select
          value={v}
          onChange={(e) => {
            setV(e.currentTarget.value);
            onChange(e.currentTarget.value);
          }}
        >
          <option value="">Unclassified</option>
          <option value="1">Late delivery</option>
          <option value="2">Wrong order</option>
          <option value="3">Cold food</option>
        </Select>
      </FormField>
    );
  }

  it('picks through the searchable menu and fires the select’s own onChange', () => {
    const onChange = vi.fn();
    render(<FormHarness onChange={onChange} />);
    // The label still resolves to the real <select> (tests and forms rely on it).
    expect(screen.getByLabelText('Category')).toBeInstanceOf(HTMLSelectElement);

    fireEvent.click(screen.getByRole('combobox', { name: 'Category' }));
    fireEvent.change(searchBox(), { target: { value: 'wrong' } });
    const option = screen.getByRole('option', { name: 'Wrong order' });
    fireEvent.click(within(option).getByRole('button'));

    expect(onChange).toHaveBeenCalledWith('2');
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveTextContent('Wrong order');
  });

  it('still follows a change made on the native select', () => {
    const onChange = vi.fn();
    render(<FormHarness onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: '3' } });
    expect(onChange).toHaveBeenCalledWith('3');
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveTextContent('Cold food');
  });
});

describe('MultiSelectMenu — type to filter', () => {
  it('filters the ticks and keeps "All" in reach', () => {
    const onChange = vi.fn();
    render(
      <MultiSelectMenu
        label="Order status"
        allLabel="All statuses"
        selected={new Set()}
        onChange={onChange}
        options={[
          { value: 'delivered', label: 'Delivered' },
          { value: 'cancelled', label: 'Cancelled' },
          { value: 'closed', label: 'Closed' },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Order status' }));
    fireEvent.change(screen.getByLabelText('Search options'), { target: { value: 'cl' } });
    expect(optionNames()).toEqual(['Closed']);
    expect(screen.getByRole('button', { name: 'All statuses' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('option', { name: 'Closed' }));
    expect(onChange).toHaveBeenCalledWith(new Set(['closed']));
  });
});
