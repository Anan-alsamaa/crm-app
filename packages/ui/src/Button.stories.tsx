import type { Meta, StoryObj } from '@storybook/react';
import { Button } from './Button.js';

const meta = {
  title: 'Primitives/Button',
  component: Button,
  tags: ['autodocs'],
  args: { children: 'Button' },
  argTypes: {
    variant: {
      control: 'select',
      options: ['default', 'brand', 'secondary', 'outline', 'ghost', 'destructive', 'link'],
    },
    size: { control: 'select', options: ['sm', 'md', 'lg', 'icon'] },
    loading: { control: 'boolean' },
    disabled: { control: 'boolean' },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Brand: Story = { args: { variant: 'brand', children: 'Save changes' } };
export const Outline: Story = { args: { variant: 'outline' } };
export const Destructive: Story = { args: { variant: 'destructive', children: 'Delete' } };
export const Loading: Story = { args: { loading: true, children: 'Saving…' } };

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {(['default', 'brand', 'secondary', 'outline', 'ghost', 'destructive', 'link'] as const).map(
        (v) => (
          <Button key={v} variant={v}>
            {v}
          </Button>
        ),
      )}
    </div>
  ),
};
