import { z } from 'zod';

// The user-facing queue contract; actions stay in the local executor.
export const tradingQueueItemSchema=z.object({
 id:z.string(),source:z.string(),state:z.enum(['waiting','needs_you','in_progress']),
 title:z.string(),detail:z.string().nullable(),reason:z.string().nullable(),
 expectedAt:z.string().nullable(),createdAt:z.string(),
 link:z.object({kind:z.literal('strategy'),id:z.string()}).nullable(),
 actions:z.array(z.enum(['cancel','confirm'])),
 approval:z.object({summary:z.string(),strategyName:z.string()}).optional(),
});
export type TradingQueueItem=z.infer<typeof tradingQueueItemSchema>;
export type TradingQueueAction=TradingQueueItem['actions'][number];
export function readTradingQueue(items:unknown):TradingQueueItem[]{
 const order={needs_you:0,in_progress:1,waiting:2};
 return z.array(tradingQueueItemSchema).parse(items).sort((a,b)=>order[a.state]-order[b.state]||a.createdAt.localeCompare(b.createdAt));
}
