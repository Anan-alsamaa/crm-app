import type { Meta, StoryObj } from '@storybook/react';
import { YijiLogo } from './YijiLogo.js';

const meta: Meta<typeof YijiLogo> = {
  title: 'Brand/YijiLogo',
  component: YijiLogo,
  tags: ['autodocs'],
  args: { size: 48, variant: 'mark' },
  argTypes: {
    size: { control: { type: 'range', min: 16, max: 128, step: 4 } },
    variant: { control: 'inline-radio', options: ['mark', 'tile'] },
  },
};

export default meta;
type Story = StoryObj<typeof YijiLogo>;

export const Mark: Story = {};
export const Tile: Story = { args: { variant: 'tile' } };
