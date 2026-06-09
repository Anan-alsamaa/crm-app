import type { Meta, StoryObj } from '@storybook/react';
import { StatCard } from './StatCard.js';

const meta: Meta<typeof StatCard> = {
  title: 'Primitives/StatCard',
  component: StatCard,
  tags: ['autodocs'],
  args: { label: 'Open conversations', value: 128, caption: 'vs 96 last week' },
  argTypes: {
    tone: {
      control: 'select',
      options: ['default', 'primary', 'success', 'warning', 'destructive', 'pink'],
    },
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 240 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof StatCard>;

export const Default: Story = {};
export const Warning: Story = {
  args: { label: 'SLA breaches', value: 3, tone: 'warning', caption: 'today' },
};
