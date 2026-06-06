import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { GhostSelect } from './GhostSelect.js';

const meta: Meta<typeof GhostSelect> = {
  title: 'Primitives/GhostSelect',
  component: GhostSelect,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof GhostSelect>;

const OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'pending', label: 'Pending' },
  { value: 'closed', label: 'Closed' },
];

export const Default: Story = {
  render: () => {
    const [value, setValue] = useState('open');
    const current = OPTIONS.find((o) => o.value === value);
    return (
      <GhostSelect
        label="Status"
        value={value}
        display={current?.label ?? value}
        options={OPTIONS}
        onChange={setValue}
      />
    );
  },
};
