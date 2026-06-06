/** Tailwind config for the @yiji/ui Storybook preview. Uses the shared design
 *  preset and scans the package's own components + stories for class usage. */
const preset = require('./tailwind-preset.cjs');

module.exports = {
  presets: [preset],
  content: ['./src/**/*.{ts,tsx}', './.storybook/**/*.{ts,tsx}'],
};
