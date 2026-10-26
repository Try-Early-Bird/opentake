import type { SavedSearchSummary } from './saved-search';
import { z } from 'zod';
import type { ChatSelection } from './chat';
import type { MarketHit } from './search';
export const searchScreeningSchema = z.object({ venue: z.string().max(80), total: z.number().int().nonnegative(), returned: z.number().int().min(0).max(20), omitted: z.number().int().nonnegative(), truncated: z.boolean(), sortedBy: z.string().max(256) }).strict();
export interface SearchAgentSnapshot {
  replay?: { id: string; title: string };
  canSave?: boolean;
  screening?: z.infer<typeof searchScreeningSchema>;
  id: string; question: string; sources: string[]; selection: ChatSelection;
  state: 'running' | 'completed' | 'failed' | 'cancelled'; text: string; markets: MarketHit[]; error?: string;
}
export interface SearchAgentApproval { id: string; title: string; detail: string }
export type SearchRecoveryPreview = { status: 'none' | 'missing' | 'ambiguous' } | { status: 'ready'; id: string; title: string; token: string };
export interface SearchBackupPreview { token: string; screens: SavedSearchSummary[]; skipped: number }
export interface SearchAgentAPI {
  exportBackup(): Promise<{ status: 'saved' | 'cancelled' }>;
  previewBackup(): Promise<{ status: 'cancelled' } | { status: 'preview'; preview: SearchBackupPreview }>;
  importBackup(token: string): Promise<{ imported: number; skipped: number }>;
  previewRecovery(): Promise<SearchRecoveryPreview>;
  confirmRecovery(token: string): Promise<void>;
  saved(): Promise<SavedSearchSummary[]>;
  save(run: string, title: string, venues: string[]): Promise<SavedSearchSummary>;
  removeSaved(id: string): Promise<void>;
  replay(id: string): Promise<string>;
  start(request: { question: string; sources: string[] }): Promise<string>;
  snapshot(id: string): Promise<SearchAgentSnapshot & { approvals: SearchAgentApproval[] }>;
  stop(id: string): Promise<void>;
  decide(run: string, approval: string, allow: boolean): Promise<void>;
}
