import type { Meta, StoryObj } from '@storybook/react';
import { EmptyState } from './EmptyState.js';
import { Button } from './Button.js';

const meta: Meta<typeof EmptyState> = {
  title: 'Primitives/EmptyState',
  component: EmptyState,
  tags: ['autodocs'],
  args: {
    title: 'No conversations yet',
    description: 'When a customer starts a chat, it lands here.',
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 420 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof EmptyState>;

export const Default: Story = {};
export const WithAction: Story = {
  args: { action: <Button variant="brand">New conversation</Button> },
};
