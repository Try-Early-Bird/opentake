import {marketIdentifierError} from '../../shared/source-market-identifiers';
import { marketKey } from '../../shared/search';
import { destinationSchema } from './destination-schema';
import { z } from 'zod';

const name = z.string().trim().min(1).max(80);
const path = z.array(z.string().min(1).max(80).refine(value => !['__proto__', 'prototype', 'constructor'].includes(value))).min(1).max(8);
export const endpointSchema = z.string().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (!url.port || url.port === '443') && !url.username && !url.password && !url.hash && !url.search;
  } catch { return false; }
}, 'Use an HTTPS endpoint on port 443 without embedded credentials, a query or fragment.');
const mapping = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text') }).strict(),
  z.object({ kind: z.literal('metric'), valuePath: path }).strict(),
  z.object({ kind: z.literal('boolean'), valuePath: path }).strict(),
  z.object({ kind: z.literal('event'), fields: z.record(name, z.object({ path, type: z.enum(['string', 'number', 'boolean', 'null']) }).strict())
    .refine(fields => Object.keys(fields).length > 0 && Object.keys(fields).length <= 32 && Object.keys(fields).every(key => !['__proto__', 'prototype', 'constructor'].includes(key))) }).strict(),
]);
export const sourceConfigBase = z.object({
  name, endpoint: endpointSchema,
  credentialId: z.uuid().optional(),
  collection: z.enum(['automatic', 'when-open', 'off']).default('when-open'),
  pollIntervalMs: z.number().int().min(15_000).max(86_400_000).default(60_000),
  feeds: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), name, unit: name,
    mapping, eventTimePath: path.optional(),
    destination: destinationSchema.optional(),
    storage: z.object({
      mode: z.enum(['live', 'latest', 'history']),
      fields: z.array(name).min(1).max(32).refine(fields => new Set(fields).size === fields.length),
      sampleEveryMs: z.number().int().min(1000).max(86_400_000).default(60_000),
      retentionDays: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]).default(7),
    }).strict(),
  }).strict()).min(1).max(10),
}).strict();
export function validateSourceConfig(config: Pick<z.infer<typeof sourceConfigBase>, 'feeds'>, ctx: z.RefinementCtx) {
  if (new Set(config.feeds.map(feed => feed.id)).size !== config.feeds.length) ctx.addIssue({ code: 'custom', message: 'Feed IDs must be unique.' });
  const destinations = new Set<string>();
  for (const feed of config.feeds) {
    if (feed.destination && feed.destination.kind !== 'custom-feed') {
      const key = (feed.destination.kind==='market-prices'?`routed-${feed.destination.market.venue}`:marketKey({ identity: feed.destination.market })) + (feed.destination.kind === 'market-metadata' ? ':' + feed.destination.namespace : ':price');
      if (destinations.has(key)) ctx.addIssue({ code: 'custom', message: 'Each destination can have only one feed per source.' });
      destinations.add(key);
    }
    if (feed.destination && feed.destination.kind !== 'custom-feed') {
      if(feed.destination.kind==='market-prices'){
        const d=feed.destination,m=feed.mapping;
        const identifierError=marketIdentifierError(d.market.venue,d.identifier);
        if(identifierError)ctx.addIssue({code:'custom',message:identifierError});
        if(m.kind!=='event'||feed.unit!=='USD'||!feed.eventTimePath)ctx.addIssue({code:'custom',message:'Routed prices require USD events and provider timestamps.'});
        else {
          if(m.fields[d.symbolField]?.type!=='string'||m.fields[d.priceField]?.type!=='string')ctx.addIssue({code:'custom',message:'Market symbol and exact decimal price must be declared string fields.'});
          for(const c of d.conditions){const type=m.fields[c.field]?.type;
            const values=c.op==='in'?c.values:[c.value];
            if(!type||values.some(value=>(value===null?'null':typeof value)!==type)||(['gt','gte','lt','lte'].includes(c.op)&&type!=='number'))ctx.addIssue({code:'custom',message:'Write conditions require declared fields with compatible types.'});
          }
        }
      }
      if (feed.storage.mode === 'live') ctx.addIssue({ code: 'custom', message: 'Destination writes require retained storage.' });
      if (feed.destination.kind === 'market-price' && (feed.mapping.kind !== 'metric' || feed.unit !== 'USD' || !feed.eventTimePath)) ctx.addIssue({ code: 'custom', message: 'Market prices require a USD metric and provider timestamp in Unix milliseconds.' });
      if (feed.destination.kind === 'market-metadata' && feed.mapping.kind !== 'event') ctx.addIssue({ code: 'custom', message: 'Market metadata requires declared event fields.' });
    }
    const allowed = feed.mapping.kind === 'event' ? Object.keys(feed.mapping.fields) : ['value'];
    if (feed.storage.fields.some(field => !allowed.includes(field))) ctx.addIssue({ code: 'custom', message: 'Choose fields declared by this feed.' });
  }
  if (Buffer.byteLength(JSON.stringify(config)) > 32 * 1024) ctx.addIssue({ code: 'custom', message: 'Source configuration exceeds 32 KiB.' });
}
export const sourceConfigSchema = sourceConfigBase.superRefine(validateSourceConfig).superRefine((config, ctx) => { if (config.feeds.some(feed => feed.mapping.kind === 'text')) ctx.addIssue({code:'custom',message:'Text feeds require WebSocket transport'}); });
export type CustomSourceConfig = z.infer<typeof sourceConfigSchema>;
export interface StoredSource { id: string; ownerId: string; revision: number; enabled: boolean; validated: boolean; config: CustomSourceConfig }
