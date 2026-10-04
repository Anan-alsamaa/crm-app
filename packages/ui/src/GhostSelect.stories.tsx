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

/**
 * A NAMED COMPONENT, not an inline `render` arrow.
 *
 * Storybook calls `render` as a component, so the `useState` below was always
 * safe in practice — but `rules-of-hooks` cannot know that: it sees a hook in a
 * lowercase function and has to assume the worst, because a hook in a plain
 * helper is a real and silent crash.
 *
 * Hoisting it to a capitalised component makes the story say what it already
 * was, and keeps the rule able to check it rather than having to be suppressed.
 * A disable comment here would train the next reader to add one.
 */
function GhostSelectStory() {
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
}

export const Default: Story = {
  render: () => <GhostSelectStory />,
};
