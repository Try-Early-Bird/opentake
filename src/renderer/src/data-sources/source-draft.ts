import type { CustomSourceConfig, InspectedSourceField } from '../../../shared/data-sources';

/** Field paths are arrays so dotted keys cannot alias nested properties. */
export function buildSourceDraft(input: {
  name: string; endpoint: string; credentialId: string; fields: InspectedSourceField[]; unit: string;
  destination?: CustomSourceConfig['feeds'][number]['destination']; eventTimePath?: string[]; metadataKeys?: string[]; feedId?: string; retainedFields?:string[];
  collection: CustomSourceConfig['collection']; pollIntervalMs: number;
  mode: 'live' | 'latest' | 'history'; sampleEveryMs: number; retentionDays: 1 | 7 | 30 | 90;
}): CustomSourceConfig {
  if (!input.name.trim() || !input.unit.trim() || input.fields.length < 1 || input.fields.length > 32 || input.fields.some(field => !field.selectable || field.type === 'array')) throw Error('Choose 1–32 supported fields and enter a name and unit.');
  const single = input.fields.length === 1 ? input.fields[0] : null;
  const scalar = !['market-metadata','market-prices'].includes(input.destination?.kind??'') && single && (single.type === 'number' || single.type === 'boolean' || input.destination?.kind==='market-price'&&single.type==='string');
  const fields = Object.fromEntries(input.fields.map((field, index) => [input.metadataKeys?.[index] ?? `field_${index + 1}`, { path: field.path, type: field.type as 'string' | 'number' | 'boolean' | 'null' }]));
  if (input.destination && input.destination.kind !== 'custom-feed' && input.mode === 'live') throw Error('Market destinations require retained storage.');
  if (input.destination?.kind === 'market-price' && (!single || !['number','string'].includes(single.type) || !input.eventTimePath?.length)) throw Error('Choose one numeric price and a provider timestamp.');
  if (input.metadataKeys && (input.metadataKeys.length !== input.fields.length || new Set(input.metadataKeys).size !== input.metadataKeys.length || input.metadataKeys.some(key => !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key)))) throw Error('Use unique metadata field names.');
  return { name: input.name.trim(), endpoint: input.endpoint.trim(), ...(input.credentialId ? { credentialId: input.credentialId } : {}), collection: input.collection, pollIntervalMs: input.pollIntervalMs,
    feeds: [{ id: input.feedId ?? 'selected', name: input.name.trim(), unit: ['market-price','market-prices'].includes(input.destination?.kind??'') ? 'USD' : input.unit.trim(),
      ...(input.destination ? { destination: input.destination } : {}), ...(input.eventTimePath ? { eventTimePath: input.eventTimePath } : {}),
      mapping: scalar ? { kind: single.type === 'boolean' ? 'boolean' : 'metric', valuePath: single.path } : { kind: 'event', fields },
      storage: { mode: input.mode, fields: input.retainedFields?.length&&input.retainedFields.every(key=>(scalar?['value']:Object.keys(fields)).includes(key))?[...input.retainedFields]:scalar ? ['value'] : Object.keys(fields), sampleEveryMs: input.sampleEveryMs, retentionDays: input.retentionDays } }],
  };
}
