import type { Meta, StoryObj } from '@storybook/react';
import { Toolbar, ToolbarSpacer } from './Toolbar.js';
import { Button } from './Button.js';
import { Pill } from './Pill.js';

const meta: Meta<typeof Toolbar> = {
  title: 'Primitives/Toolbar',
  component: Toolbar,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof Toolbar>;

export const Default: Story = {
  render: () => (
    <Toolbar>
      <strong className="text-sm">Inbox</strong>
      <Pill tone="primary" size="sm">
        12 open
      </Pill>
      <ToolbarSpacer />
      <Button variant="outline" size="sm">
        Filter
      </Button>
      <Button variant="brand" size="sm">
        New
      </Button>
    </Toolbar>
  ),
};
