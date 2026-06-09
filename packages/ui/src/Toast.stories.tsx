import type { Meta, StoryObj } from '@storybook/react';
import { toast, Toaster } from './Toast.js';
import { Button } from './Button.js';

/**
 * Toasts are published imperatively via the `toast` API and rendered by a
 * single `<Toaster />` mounted near the app root. Click the buttons to fire one.
 */
const meta: Meta<typeof Toaster> = {
  title: 'Feedback/Toast',
  component: Toaster,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof Toaster>;

export const Playground: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <Button onClick={() => toast('Saved as draft')}>Default</Button>
      <Button variant="brand" onClick={() => toast.success('Changes saved')}>
        Success
      </Button>
      <Button variant="outline" onClick={() => toast.warning('Approaching SLA breach')}>
        Warning
      </Button>
      <Button variant="destructive" onClick={() => toast.error('Could not send message')}>
        Error
      </Button>
      <Toaster />
    </div>
  ),
};
