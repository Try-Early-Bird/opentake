import { z } from 'zod';
export interface TakePlanAccount { id: string; venue: string; label: string; available: boolean; disabledReason: string | null; otherTakeCount: number; balances: {asset:string;amount:string}[] }
export interface TakeAccountPlan {
 takeId: string; strategyId: string; draftRevision: string; revision: string | null;
 editable: boolean; reason: string | null;
 accounts: TakePlanAccount[];
 routes: { venue: string; accountId: string | null; assets: { symbol: string; bps: number }[] }[];
}
export const saveTakeAccountPlanSchema = z.object({
 takeId: z.uuid(), draftRevision: z.uuid(), revision: z.uuid().nullable(),
 routes: z.array(z.object({ venue: z.enum(['coinbase','robinhood']), accountId: z.uuid() }).strict()).max(2),
}).strict().refine(value => new Set(value.routes.map(route => route.venue)).size === value.routes.length, 'Choose one account per platform.');
export type SaveTakeAccountPlan = z.infer<typeof saveTakeAccountPlanSchema>;
export interface PlannedPortfolioTake {
 capital?: {asset:string;quantity:string}[];
 takeId: string; strategyId: string; title: string; venue: string;
 assets: { symbol: string; bps: number }[];
}
