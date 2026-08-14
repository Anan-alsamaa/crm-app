import type { Meta, StoryObj } from '@storybook/react';
import { StatCard } from './StatCard.js';
import { DeltaBadge, ProgressRing, Sparkline } from './Metrics.js';
import { InboxIcon } from './Icon.js';

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
      <div style={{ maxWidth: 280 }}>
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

/** Full board anatomy: icon chip, unit, delta pill and a trailing visual. */
export const WithUnitAndDelta: Story = {
  args: {
    label: 'Load served',
    value: '82.4',
    unit: 'MW',
    tone: 'primary',
    caption: undefined,
    icon: <InboxIcon size={16} />,
    delta: <DeltaBadge direction="up">+8.6%</DeltaBadge>,
  },
};

export const WithProgressRing: Story = {
  args: {
    label: 'SLA met',
    value: 92,
    unit: '%',
    tone: 'success',
    caption: undefined,
    visual: <ProgressRing value={92} tone="success" label="92%" />,
  },
};

export const WithSparkline: Story = {
  args: {
    label: 'Tickets this week',
    value: 47,
    tone: 'primary',
    caption: 'vs 39 last week',
    delta: (
      <DeltaBadge direction="down" positiveIsGood={false}>
        -4.1%
      </DeltaBadge>
    ),
    visual: <Sparkline points={[9, 12, 7, 14, 11, 18, 16]} tone="primary" />,
  },
};
