import type { Meta, StoryObj } from '@storybook/react';
import { IconButton } from './IconButton.js';
import { BellIcon } from './Icon.js';

const meta: Meta<typeof IconButton> = {
  title: 'Primitives/IconButton',
  component: IconButton,
  tags: ['autodocs'],
  args: { 'aria-label': 'Notifications', children: <BellIcon /> },
  argTypes: {
    variant: { control: 'inline-radio', options: ['ghost', 'secondary', 'outline'] },
    size: { control: 'inline-radio', options: ['sm', 'md', 'lg'] },
  },
};

export default meta;
type Story = StoryObj<typeof IconButton>;

export const Ghost: Story = {};
export const Outline: Story = { args: { variant: 'outline' } };

export const Variants: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8 }}>
      {(['ghost', 'secondary', 'outline'] as const).map((v) => (
        <IconButton key={v} variant={v} aria-label={`Notifications ${v}`}>
          <BellIcon />
        </IconButton>
      ))}
    </div>
  ),
};
