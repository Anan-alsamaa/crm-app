import type { Meta, StoryObj } from '@storybook/react';
import { Spinner, Skeleton } from './Spinner.js';

const meta = {
  title: 'Primitives/Spinner',
  component: Spinner,
  tags: ['autodocs'],
  args: { size: 16 },
} satisfies Meta<typeof Spinner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Large: Story = { args: { size: 32 } };

export const SkeletonRows: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 8, width: 280 }}>
      <Skeleton className="h-4 w-3/4 rounded" />
      <Skeleton className="h-4 w-1/2 rounded" />
      <Skeleton className="h-4 w-2/3 rounded" />
    </div>
  ),
};
