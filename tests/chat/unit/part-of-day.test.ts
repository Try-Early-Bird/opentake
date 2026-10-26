import { expect, test } from 'vitest';
import { partOfDay } from '../../../src/renderer/src/lib/part-of-day';

test('the home greeting follows local time, and the small hours are evening, not morning', () => {
  expect([0, 2, 4].map(partOfDay)).toEqual(['evening', 'evening', 'evening']);
  expect([5, 11].map(partOfDay)).toEqual(['morning', 'morning']);
  expect([12, 17].map(partOfDay)).toEqual(['afternoon', 'afternoon']);
  expect([18, 23].map(partOfDay)).toEqual(['evening', 'evening']);
});
