import type { Meta, StoryObj } from '@storybook/react';
import { Card, CardHeader, CardTitle, CardSubtitle } from './Card.js';

const meta: Meta<typeof Card> = {
  title: 'Primitives/Card',
  component: Card,
  tags: ['autodocs'],
  argTypes: { padding: { control: 'inline-radio', options: ['none', 'sm', 'md', 'lg'] } },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 360 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof Card>;

export const Basic: Story = {
  args: { children: 'A plain surface with default padding.' },
};

export const WithHeader: Story = {
  render: (args) => (
    <Card {...args}>
      <CardHeader>
        <CardTitle>Conversation volume</CardTitle>
        <CardSubtitle>Last 7 days</CardSubtitle>
      </CardHeader>
      <p className="text-sm text-muted-foreground">128 conversations, 96 resolved.</p>
    </Card>
  ),
};
