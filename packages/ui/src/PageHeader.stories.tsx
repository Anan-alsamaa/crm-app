import type { Meta, StoryObj } from '@storybook/react';
import { PageHeader } from './PageHeader.js';
import { Button } from './Button.js';

const meta: Meta<typeof PageHeader> = {
  title: 'Primitives/PageHeader',
  component: PageHeader,
  tags: ['autodocs'],
  args: { title: 'Users', subtitle: 'Manage agents and admins.' },
  argTypes: { size: { control: 'inline-radio', options: ['md', 'lg', 'xl'] } },
};

export default meta;
type Story = StoryObj<typeof PageHeader>;

export const Default: Story = {};

export const WithEyebrowAndActions: Story = {
  args: {
    eyebrow: 'Settings',
    title: 'Teams',
    subtitle: 'Group agents for routing and reporting.',
    actions: <Button variant="brand">Create team</Button>,
    size: 'lg',
  },
};
