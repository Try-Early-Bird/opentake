import {z} from 'zod';
import type {DataObservation} from './data-sources';
export const takeInputSchema=z.object({
 key:z.string().regex(/^[a-z][a-z0-9_]{0,39}$/).refine(key=>!['constructor','prototype','__proto__'].includes(key)),
 sourceId:z.uuid(),sourceRevision:z.number().int().positive(),feedId:z.string().min(1).max(80),
 field:z.string().min(1).max(128).refine(key=>!['constructor','prototype','__proto__'].includes(key)),
 kind:z.enum(['metric','boolean','event']),unit:z.string().min(1).max(80),maxAgeMs:z.number().int().min(1000).max(86400000),
}).strict();
export const takeInputsConfigSchema=z.object({inputs:z.array(takeInputSchema).max(16).refine(items=>new Set(items.map(item=>item.key)).size===items.length),maxSkewMs:z.number().int().min(0).max(86400000)}).strict();
export type TakeInput=z.infer<typeof takeInputSchema>;
export type TakeInputsConfig=z.infer<typeof takeInputsConfigSchema>;
export interface TakeInputsSetting {takeId:string;revision:number;acceptedVersion:string;config:TakeInputsConfig}
export type TakeInputQuality='fresh'|'missing'|'stale'|'gap'|'invalid'|'disabled'|'source-changed'|'version-changed';
export interface TakeInputValue {binding:TakeInput;quality:TakeInputQuality;value:string|number|boolean|null;ageMs:number|null;observation:DataObservation|null}
export interface TakeInputSnapshot {takeId:string;bindingRevision:number;acceptedVersion:string;capturedAt:number;status:'ready'|'blocked';reason:'inputs-unavailable'|'time-skew'|'no-inputs'|null;inputs:TakeInputValue[]}
export type TakeInputRequest={action:'take-inputs-load';takeId:string}|{action:'take-inputs-save';setting:TakeInputsSetting}|{action:'take-inputs-snapshot';takeId:string};
