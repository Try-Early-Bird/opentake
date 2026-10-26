import { expect, test } from 'vitest';
import { inspectSourceResponse } from '../../../src/main/data-sources/inspection';

test('discovers nested primitive paths and preserves exact types without guessing dates or units', () => {
  const result = inspectSourceResponse({ quote: { price: 62, currency: 'USD', available: true, missing: null }, updated_at: '2026-10-16T14:30:00Z', numericText: '1.25', rows: [{ price: 1 }] });
  expect(result).toMatchObject({ inferredFrom: 'single-response', truncated: false });
  expect(result.fields).toContainEqual({ path: ['quote', 'price'], type: 'number', sample: 62, selectable: true });
  expect(result.fields).toContainEqual({ path: ['numericText'], type: 'string', sample: '1.25', selectable: true });
  expect(result.fields).toContainEqual({ path: ['rows'], type: 'array', sample: '1 items', selectable: false });
  expect(result.fields.find(field => field.path[0] === 'updated_at')?.type).toBe('string');
});

test('omits sensitive fields, dangerous property paths and echoed credentials', () => {
  const result = inspectSourceResponse(JSON.parse('{"score":62,"access_token":"fixture-token","nested":{"password":"fixture-password"},"innocent":"echo fixture-token value","__proto__":{"polluted":true}}'), ['fixture-token']);
  expect(result.fields).toEqual([{ path: ['score'], type: 'number', sample: 62, selectable: true }]);
  expect(JSON.stringify(result)).not.toContain('fixture');
  expect(inspectSourceResponse({ 'fixture-token': 123 }, ['fixture-token']).fields).toEqual([]);
});

test('bounds field counts, traversal depth and sample lengths and rejects root arrays', () => {
  const wide = inspectSourceResponse(Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`field${i}`, i])));
  expect(wide.fields).toHaveLength(64); expect(wide.truncated).toBe(true);
  const deep = inspectSourceResponse({ a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } });
  expect(deep.fields).toHaveLength(0); expect(deep.truncated).toBe(true);
  expect(inspectSourceResponse({ text: 'a'.repeat(1000) }).fields[0].sample).toHaveLength(161);
  expect(() => inspectSourceResponse([{ price: 1 }])).toThrow('item mapping');
});
