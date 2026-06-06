import type { Preview } from '@storybook/react';
import './preview.css';

const preview: Preview = {
  parameters: {
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    backgrounds: {
      default: 'app',
      values: [
        { name: 'app', value: 'oklch(0.985 0.002 230)' },
        { name: 'card', value: '#ffffff' },
        { name: 'rail', value: 'oklch(0.22 0.045 196)' },
      ],
    },
    a11y: { test: 'todo' },
  },
};

export default preview;
