import type { Meta, StoryObj } from '@storybook/react';
import { Avatar } from './Avatar.js';

const meta = {
  title: 'Primitives/Avatar',
  component: Avatar,
  tags: ['autodocs'],
  args: { name: 'Rana Obeid', size: 'md' },
  argTypes: { size: { control: 'inline-radio', options: ['xs', 'sm', 'md', 'lg'] } },
} satisfies Meta<typeof Avatar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Initials: Story = {};
export const FromEmail: Story = { args: { name: null, email: 'demo.customer@example.com' } };

export const Sizes: Story = {
  render: () => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      {(['xs', 'sm', 'md', 'lg'] as const).map((s) => (
        <Avatar key={s} name="Yiji Agent" size={s} />
      ))}
    </div>
  ),
};
