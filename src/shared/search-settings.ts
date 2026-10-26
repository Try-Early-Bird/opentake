import { z } from 'zod';
import { reasoningEfforts } from './ai-models';

export const searchPermissionSchema = z.enum(['ask', 'allowed', 'blocked']);
export const searchSettingsSchema = z.object({
  version: z.literal(1),
  selection: z.object({
    provider: z.enum(['grok', 'claude', 'chatgpt', 'opencode', 'openrouter', 'local']),
    model: z.string().trim().min(1).max(256),
    effort: z.enum(reasoningEfforts).optional(),
  }).strict().nullable(),
  permissions: z.object({
    marketData: searchPermissionSchema,
    managedScreeners: searchPermissionSchema,
  }).strict(),
}).strict();
export type SearchSettings = z.infer<typeof searchSettingsSchema>;
export const defaultSearchSettings = (): SearchSettings => ({
  version: 1, selection: null, permissions: { marketData: 'allowed', managedScreeners: 'ask' },
});
