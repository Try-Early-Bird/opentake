import { z } from 'zod';
// Leave room for the host RPC envelope (8 MiB maximum).
export const SAVED_SEARCH_BACKUP_MAX_BYTES = 4 * 1024 * 1024;
const text = z.string().trim().min(1).max(256);
export const savedSearchSourceSchema = z.object({
  adapterVersion: z.literal(1),
  scope: z.object({ venue: text, instance: text, connectionId: text, accountId: text }).strict(),
  definition: z.object({
    filters: z.array(z.object({ filter_type: text, predicate: text, values: z.array(text).min(1).max(100),
      interval: text.optional(), length: z.number().int().positive().optional() }).strict()).min(1).max(20),
    sorting_column: text, sorting_direction: z.enum(['asc', 'desc']),
  }).strict(),
}).strict();
export type SavedSearchSource = z.infer<typeof savedSearchSourceSchema>;
export interface SavedSearchSummary {
  id: string; title: string; question: string; venues: string[]; createdAt: string;
  conditions: string[];
}
