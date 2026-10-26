import { grokExecutor } from './grok-chat';
import { claudeExecutor, type AgentExecutor as TakeExecutor } from './take-runtime';
import { codexExecutor } from './codex-chat';
import { opencodeExecutor } from './opencode-chat';
import type { SecretStore } from './secret-store';
import type { AiModel, ModelProvider } from '../shared/ai-models';
import { openRouterBaseUrl } from './openrouter-connection';

export const chatAdapterIds:Record<ModelProvider,string>={grok:'grok-acp',claude:'claude-cli',chatgpt:'codex-app-server',opencode:'opencode-server',openrouter:'opencode-openrouter',local:'opencode-local'};
export function createChatExecutor(store:SecretStore,profile:string,bridge:string,zenKey:()=>Promise<string>,localBaseUrl:()=>Promise<string>,
  openRouter:{key:()=>Promise<string>;model:(id:string)=>Promise<AiModel|undefined>}):TakeExecutor {
  const none=async()=>'';
  const executors:Record<ModelProvider,TakeExecutor>={grok:grokExecutor(store,profile),claude:claudeExecutor(store,profile,bridge),chatgpt:codexExecutor(store,profile),opencode:opencodeExecutor(zenKey,profile,bridge),
    openrouter:opencodeExecutor(none,profile,bridge,{},{kind:'compatible',providerID:'openrouter',name:'OpenRouter',baseUrl:async()=>openRouterBaseUrl,apiKey:openRouter.key,model:openRouter.model,missing:'Connect OpenRouter in Settings.'}),
    local:opencodeExecutor(none,profile,bridge,{},{kind:'compatible',providerID:'local',name:'Local',baseUrl:localBaseUrl,missing:'Connect a local model server in Settings.'})};
  return input=>executors[input.selection.provider](input);
}
