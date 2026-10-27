import type { DocumentAttachment, DocumentAction } from './chat-documents';
import type { ChatUsage, ChatBudgets,AutomaticRunLimits, RunUsage } from './chat-usage';
export type ReplayPart = {type:'text';text:string}|{type:'tool_use';id:string;name:string;input:unknown}|{type:'tool_result';tool_use_id:string;content:string;is_error:boolean};
export interface ReplayMessage { role:'user'|'assistant'; content:ReplayPart[] }
import type { ChatSelection } from './chat';
export type RunState = 'starting' | 'running' | 'stopping' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface ImageAttachment { id: string; name: string; mime: string; width: number; height: number; bytes: number }
export interface ToolActivity { id: string; name: string; state: 'running' | 'completed' | 'failed'; startedAt: string; finishedAt?: string; detail?: string }
/** The limits an automatic rule run started with, shown on its thread card. */
export interface RuleRunLimits { durationMs: number; toolCalls?: number; modelTurns?: number; costUsd: number; outputTokens?: number }
export interface TakeMessage { documents?:DocumentAttachment[]; coinbaseAccount?: { accountRef: string; label: string }; context?:{condensedMessages:number}; versionNumber?:number;versionCount?:number; usage?:ChatUsage; id: string; parentId: string | null; role: 'user' | 'assistant'; text: string; images: ImageAttachment[]; createdAt: string; selection: ChatSelection; state: RunState; tools: ToolActivity[]; error?: string; runId?: string; replay?:ReplayMessage[]; instructions?: InstructionLabel;
  /** Brought in from a take file: shown as written, given to the AI only as quoted reference (main/take-file.ts). */
  imported?: { exportedAt: string; tools?: string[] };
  /** Written by the app when a rule started this turn, not by the member. */
  ruleRun?: { requestId: string; ruleId: string; ruleName: string; limits?: RuleRunLimits };
  /** Why a failed reply stopped early: a budget the member set in Settings, or a fixed run limit. */
  stopReason?: 'budget' | 'limit' }
export type TakePermissionMode='auto'|'ask';
export interface Take { draftDocuments?:DocumentAttachment[]; iconId?:string|null; strategyId?:string|null;archiveOnly?:boolean; permissionMode:TakePermissionMode; id: string; title: string; updatedAt: string; archivedAt: string | null; headId: string | null; draft: string; draftImages: ImageAttachment[]; instructions: string; instructionProfileId: string | null; selection: ChatSelection; messages: TakeMessage[] }
export interface TakeSummary { id: string; title: string; updatedAt: string; archivedAt: string | null;
  /** The take's strategy, when it authored one: a draft, a committed version, and whether money follows it. */
  strategy?: { status: 'draft' | 'committed'; invested: boolean } | null }
export interface TakeSend { documents?:string[]; coinbaseAccountRef?: string | null; requestId: string; takeId: string; parentId: string | null; text?: string; images?: string[]; selection: ChatSelection; instructionProfileId?: string | null; regenerate?: boolean;
  /** Sent from the thread (retry, edit, continue), not the composer: leave the member's unsent draft alone. */
  keepDraft?: boolean }
export interface InstructionProfile { id: string; name: string; text: string; updatedAt: string; config: ModeConfig; published: PublishedMode | null; builtin: boolean; followsDefault: boolean }
import type { ModeConfig, ModeFlow, PublishedMode, InstructionLabel } from './instruction-modes';
export interface TakeSnapshot { mode?:'replace'|'merge';messagesNext?:string|null;takesNext?:string|null; revision: string; activeTakeId?: string | null; activeTakeIds?: string[]; takes: TakeSummary[]; take: Take | null; running: boolean }
export interface TakesAPI {
  document(action:DocumentAction,input:unknown):Promise<unknown>;
  /** Saves the take (title, strategy, conversation) to a file the member chooses. */
  exportFile(takeId:string):Promise<{status:'saved'|'cancelled'}>;
  /** Imports a take file as a new take; its strategy arrives as a draft to review. */
  importFile():Promise<{status:'imported';takeId:string}|{status:'cancelled'}>;
  messagesPage(takeId:string,cursor:string):Promise<{messages:TakeMessage[];next:string|null}>;
  takesPage(archived:boolean,cursor:string):Promise<{items:TakeSummary[];next:string|null}>;
  messageVersions(takeId:string,messageId:string,cursor?:string):Promise<{items:{id:string;number:number}[];next:string|null}>;
  budgets():Promise<ChatBudgets>;
  saveBudgets(value:ChatBudgets):Promise<void>;
  automaticLimits():Promise<AutomaticRunLimits>;
  saveAutomaticLimits(value:AutomaticRunLimits):Promise<AutomaticRunLimits>;
  usageHistory(takeId:string,before?:string):Promise<{items:RunUsage[];next:string|null}>;
  snapshot(id: string | null, archived: boolean, revision?: string): Promise<TakeSnapshot | null>;
  create(): Promise<string>;
  update(id: string, patch: { iconId?:string|null; permissionMode?:TakePermissionMode; title?: string; archived?: boolean; draft?: string; draftImages?: string[]; draftDocuments?:string[]; instructions?: string; instructionProfileId?: string | null; headId?: string | null }): Promise<void>;
  remove(id: string): Promise<void>;
  send(request: TakeSend): Promise<void>;
  stop(id: string): Promise<void>;
  upload(takeId: string, name: string, base64: string): Promise<ImageAttachment>;
  image(id: string): Promise<string>;
  instructions(): Promise<{ defaults: string; flow: ModeFlow; required: string; about: string }>;
  instructionProfiles(): Promise<InstructionProfile[]>;
  saveInstructionProfile(profile: { id?: string; name: string; text: string; config?: ModeConfig }): Promise<string>;
  publishInstructionProfile(id: string): Promise<void>;
  instructionVersions(id: string): Promise<PublishedMode[]>;
  removeInstructionProfile(id: string): Promise<void>;
  saveAbout(text: string): Promise<void>;
  restoreDefaultInstructions(id: string): Promise<void>;
  openLink(url: string): Promise<void>;
}
export function visibleMessages(take: Take): TakeMessage[] {
  const lookup = new Map(take.messages.map(m => [m.id, m])); const path: TakeMessage[] = []; const seen = new Set<string>();
  let id = take.headId;
  while (id && !seen.has(id)) { seen.add(id); const m = lookup.get(id); if (!m) break; path.unshift(m); id = m.parentId; }
  return path;
}
