import { describe, it, expect } from 'vitest';
import { lineModifierGroups } from '../src/yiji-impl.js';

/* Owner, 2026-10-12: the add-ons grouped and priced, as Yiji's order screen. */
describe('lineModifierGroups', () => {
  it('keeps each group with its chosen options, quantities and prices', () => {
    expect(
      lineModifierGroups({
        extraModifiers: [
          {
            extraModifierName: 'Extra',
            elements: [
              { elementName: 'Light Spicy', quantity: 1, elementPrice: 0 },
              { elementName: ' Cheese ', quantity: 2, elementPrice: 5 },
            ],
          },
          { extraModifierName: 'Sauce', elements: [] },
          {
            extraModifierName: 'Vegetables Type',
            elements: [{ elementName: 'Green & Red Pepper' }],
          },
        ],
      }),
    ).toEqual([
      {
        name: 'Extra',
        options: [
          { name: 'Light Spicy', qty: 1, price: 0 },
          { name: 'Cheese', qty: 2, price: 5 },
        ],
      },
      // A group with nothing chosen is left out; missing qty/price read as 1 / 0.
      { name: 'Vegetables Type', options: [{ name: 'Green & Red Pepper', qty: 1, price: 0 }] },
    ]);
  });
});
