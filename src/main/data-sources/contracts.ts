import { z } from 'zod';
import type { DataPayload } from '../../shared/data-sources';

// PostgreSQL jsonb rejects NUL; one such string would otherwise block shared storage.
export const hasNul = (value: unknown): boolean => typeof value === 'string' ? value.includes('\u0000') : Array.isArray(value) ? value.some(hasNul) : !!value && typeof value === 'object' && Object.entries(value).some(([key, item]) => key.includes('\u0000') || hasNul(item));
const noNul = (value: string) => !value.includes('\u0000');
const id = z.string().min(1).max(128).refine(noNul, 'NUL characters are not supported');
const decimal = z.string().max(80).regex(/^-?(0|[1-9]\d*)(\.\d+)?$/);
const positive = decimal.refine(value => !value.startsWith('-') && /[1-9]/.test(value));
const nonnegative = decimal.refine(value => !value.startsWith('-'));
const time = z.number().int().nonnegative().max(8_640_000_000_000_000);
const level = z.tuple([positive, nonnegative]);
export const payloadSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('text'),value:z.string().max(65536).refine(noNul).refine(value=>Buffer.byteLength(value)<=65536)}).strict(),
  z.object({ kind: z.literal('metric'), value: decimal }).strict(),
  z.object({ kind: z.literal('boolean'), value: z.boolean() }).strict(),
  z.object({ kind: z.literal('event'), fields: z.record(id, z.union([z.string().max(2048).refine(noNul), z.number().finite(), z.boolean(), z.null()])).refine(fields => Object.keys(fields).length <= 32) }).strict(),
  z.object({ kind: z.literal('quote'), price: positive }).strict(),
  z.object({ kind: z.literal('candle'), start: time, end: time, open: positive, high: positive, low: positive, close: positive, volume: nonnegative }).strict(),
  z.object({ kind: z.literal('book'), bids: z.array(level).max(100), asks: z.array(level).max(100) }).strict(),
  z.object({ kind: z.literal('trade'), price: positive, size: positive, side: z.enum(['maker_buy', 'maker_sell', 'unknown']) }).strict(),
]);
export const sampleSchema = z.object({
  payload: payloadSchema,
  eventTime: time.nullable(),
  origin: z.enum(['live', 'backfill']),
  providerId: id.optional(),
  sequence: z.string().max(80).regex(/^(0|[1-9]\d*)$/).optional(),
}).strict();
export type DataSample = z.infer<typeof sampleSchema>;

/** Host-only configuration. No credential values; authScope is an opaque isolation key.
 * Production transport adapters must enforce DNS/address pinning and the
 * destination policy. This registers only injected adapters and does no network I/O.
 */
export const feedSchema = z.object({
  ownerId: id, sourceId: id, configVersion: z.number().int().positive(),
  adapterId: id, authScope: id, feedId: id, schemaVersion: z.number().int().positive(),
  parameters: z.record(id, z.string().max(256)).refine(p => Object.keys(p).length <= 16).default({}),
  kind: z.enum(['text', 'metric', 'boolean', 'event', 'quote', 'candle', 'book', 'trade']),
  eventFields: z.record(id, z.enum(['string', 'number', 'boolean', 'null'])).refine(fields => Object.keys(fields).length <= 32).optional(),
  unit: id,
  market: z.object({ venue: id, product: id, base: id, quote: id }).strict().optional(),
  semantics: z.enum(['state', 'event']),
  /** Adapter must normalize sequence to this exact feed/epoch, not a raw cross-channel counter. */
  ordering: z.enum(['arrival', 'event-time', 'sequence']),
  freshnessMs: z.number().int().min(15_000).max(86_400_000),
  // Host-managed account/fill watches need 5s; custom HTTP config retains its 15s minimum.
  pollIntervalMs: z.number().int().min(5000).max(86_400_000).default(60_000),
}).strict().refine(feed => feed.kind !== 'event' || feed.eventFields !== undefined, 'Event fields must be declared');
export type FeedDefinition = z.infer<typeof feedSchema>;
export interface AdapterContext {
  feed: Readonly<FeedDefinition>;
  signal: AbortSignal;
  epoch: number;
  /** Adapter must bound raw bytes before decoding; emit validates normalized samples. */
  emit(sample: unknown): void;
  connected(): void;
  /** Activity is not a price refresh. */
  heartbeat(): void;
  fail(reason: 'transport' | 'gap' | 'invalid_data', options?: { retryAfterMs?: number; configuration?: boolean }): void;
  /** Non-blocking feed issue (e.g. no frame matches its mapping); the connection stays up. Cleared by the next observation or session. */
  warn?(reason: 'invalid_data'): void;
}
interface AdapterBase {
  id: string;
  version: string;
  kinds: readonly DataPayload['kind'][];
  /** History/replay are unsupported unless implemented in a later adapter contract. */
  history: false;
  replay: false;
}
export type SourceAdapter = AdapterBase & (
  | { transport: 'http'; poll(context: AdapterContext): Promise<void> }
  | { transport: 'websocket'; open(context: AdapterContext): () => void; heartbeatTimeoutMs: number }
);
export interface RuntimeClock { wall(): number; monotonic(): number }
