import { z } from 'zod';
import { marketIdentitySchema } from '../../shared/search';
const fieldName=z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/);
const scalar=z.union([z.string().max(256),z.number().finite(),z.boolean(),z.null()]);
export const writeConditionSchema=z.discriminatedUnion('op',[
 z.object({field:fieldName,op:z.literal('equals'),value:scalar}).strict(),
 z.object({field:fieldName,op:z.literal('in'),values:z.array(scalar).min(1).max(200)}).strict(),
 z.object({field:fieldName,op:z.enum(['gt','gte','lt','lte']),value:z.number().finite()}).strict(),
]);
export const destinationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('custom-feed') }).strict(),
  z.object({ kind: z.literal('market-price'), market: z.object({ venue: z.literal('robinhood'), instance: z.literal('production'), kind: z.literal('equity'), reference: z.string().regex(/^[A-Z][A-Z0-9.-]{0,11}$/) }).strict(),
    currency: z.literal('USD'), policy: z.enum(['fill-missing', 'replace-stale']), maxAgeMs: z.number().int().min(15000).max(300000), allowSharedPriceWrites: z.literal(true) }).strict(),
  z.object({kind:z.literal('market-prices'),market:z.union([z.object({venue:z.literal('robinhood'),instance:z.literal('production'),kind:z.literal('equity')}).strict(),z.object({venue:z.literal('coinbase'),instance:z.literal('production'),kind:z.literal('crypto')}).strict()]),
    symbolField:fieldName,identifier:z.union([z.object({kind:z.enum(['symbol','product-id'])}).strict(),z.object({kind:z.enum(['instrument-id','external-id']),mappings:z.array(z.object({from:z.string().min(1).max(256),to:z.string().min(1).max(256)}).strict()).min(1).max(200)}).strict()]).optional(),priceField:fieldName,holdings:z.object({accountIds:z.array(z.uuid()).min(1).max(32).refine(ids=>new Set(ids).size===ids.length),maxAgeMs:z.number().int().min(15000).max(86400000).default(900000)}).strict().optional(),conditions:z.array(writeConditionSchema).max(16).default([]),
    currency:z.literal('USD'),policy:z.enum(['fill-missing','replace-stale']),maxAgeMs:z.number().int().min(15000).max(300000),allowSharedPriceWrites:z.literal(true)}).strict(),
  z.object({ kind: z.literal('market-metadata'), market: marketIdentitySchema,
    namespace: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).refine(value => !['constructor','prototype','__proto__'].includes(value)), maxAgeMs: z.number().int().min(15000).max(86400000) }).strict(),
]);
