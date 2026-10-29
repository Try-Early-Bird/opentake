export interface ChatUsage {
 inputTokens?:number; outputTokens?:number; cacheReadTokens?:number; cacheWriteTokens?:number; reasoningTokens?:number; costUsd?:number;
 source:string; costKind:'api-equivalent'|'provider-reported'; partial:boolean;
 /** The provider itself said its counts are incomplete (Grok); a token limit cannot be trusted. */
 incomplete?:true;
}
export interface ChatBudgets { claudeCostUsd:number|null; outputTokens?:number|null; opencodeCostUsd?:number|null;
 /** Rule agent runs gated by tokens: stop when the provider's counts are incomplete. */
 requireCompleteUsage?:boolean }
/** AI settings › Automatic runs: the default and the maximum for every rule agent run. */
export interface AutomaticRunLimits { durationMs:number; toolCalls:number; modelTurns:number; costUsd:number; outputTokens:number }
/** AI settings › Chat responses: limits for each response a member asks for, and whether runs may use subagents. */
export interface ChatRunLimits { durationMs:number; toolCalls:number; modelTurns:number; subagents:boolean }
export const chatRunLimitBounds={durationMs:[60000,3600000],toolCalls:[1,500],modelTurns:[1,200]} as const;
export const automaticRunLimitBounds={durationMs:[1000,3600000],toolCalls:[1,500],modelTurns:[1,200],costUsd:[0.01,100],outputTokens:[1,10000000]} as const;
export interface RunUsage {id:string;state:string;startedAt:string;finishedAt:string|null;selection:{provider:string;model:string};usage:ChatUsage|null;budgets:ChatBudgets|null;error:string|null}
