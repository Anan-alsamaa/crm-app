import type { Meta, StoryObj } from '@storybook/react';
import { Pill } from './Pill.js';

const TONES = [
  'neutral',
  'primary',
  'success',
  'warning',
  'destructive',
  'muted',
  'pink',
  'orange',
  'blue',
  'purple',
  'cyan',
] as const;

const meta = {
  title: 'Primitives/Pill',
  component: Pill,
  tags: ['autodocs'],
  args: { children: 'Label', tone: 'neutral' },
  argTypes: {
    tone: { control: 'select', options: TONES },
    size: { control: 'inline-radio', options: ['sm', 'md'] },
  },
} satisfies Meta<typeof Pill>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Success: Story = { args: { tone: 'success', children: 'Resolved' } };
export const Warning: Story = { args: { tone: 'warning', children: 'SLA at risk' } };

export const AllTones: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {TONES.map((t) => (
        <Pill key={t} tone={t}>
          {t}
        </Pill>
      ))}
    </div>
  ),
};
