import type { Meta, StoryObj } from '@storybook/react';
import { FormField } from './FormField.js';
import { Input } from './Input.js';

const meta: Meta<typeof FormField> = {
  title: 'Primitives/FormField',
  component: FormField,
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 360 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof FormField>;

export const WithHint: Story = {
  args: {
    label: 'Work email',
    hint: 'We only use this for sign-in.',
    children: <Input placeholder="jane@example.com" />,
  },
};

export const WithError: Story = {
  args: {
    label: 'Work email',
    error: 'Enter a valid email address.',
    children: <Input defaultValue="not-an-email" invalid />,
  },
};
