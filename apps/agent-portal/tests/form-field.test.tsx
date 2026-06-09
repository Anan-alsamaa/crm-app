import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { FormField, Input, Select } from '@yiji/ui';

afterEach(() => cleanup());

describe('FormField label association', () => {
  it('auto-associates the label with its control (no htmlFor needed)', () => {
    render(
      <FormField label="Subject">
        <Input />
      </FormField>,
    );
    // getByLabelText only resolves when the <label> is wired to the control —
    // this is what Playwright's getByLabel relies on in the E2E flows.
    expect(screen.getByLabelText('Subject')).toBeInstanceOf(HTMLInputElement);
  });

  it('works for select controls too', () => {
    render(
      <FormField label="Role">
        <Select>
          <option value="a">A</option>
        </Select>
      </FormField>,
    );
    expect(screen.getByLabelText('Role')).toBeInstanceOf(HTMLSelectElement);
  });

  it('respects an explicit htmlFor + matching child id', () => {
    render(
      <FormField label="Email" htmlFor="email">
        <Input id="email" />
      </FormField>,
    );
    expect(screen.getByLabelText('Email').id).toBe('email');
  });
});
