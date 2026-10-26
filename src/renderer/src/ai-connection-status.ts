import type { AiConnectionsAPI, AiConnectionState } from '../../shared/ai-connections';

export type AiStatusCheck = { ok: true; states: AiConnectionState[] } | { ok: false; message: string };
const restartMessage = 'The AI connection service needs an app restart. Quit Opentake completely and reopen it, then retry.';
export async function checkAiConnections(api: Pick<AiConnectionsAPI, 'status'> | undefined): Promise<AiStatusCheck> {
  if (!api || typeof api.status !== 'function') return { ok: false, message: restartMessage };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const states = await Promise.race([api.status(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Status timeout')), 5000);
    })]);
    if (!Array.isArray(states) || !states.length || states.some(state => !state ||
      !['chatgpt', 'claude', 'grok', 'opencode', 'openrouter', 'local'].includes(state.provider) || !['disconnected', 'starting', 'pending', 'connected', 'error'].includes(state.status))) {
      return { ok: false, message: restartMessage };
    }
    return { ok: true, states };
  } catch (error) {
    const missingHandler = error instanceof Error && /No handler registered|Unknown operation/.test(error.message);
    return { ok: false, message: missingHandler ? restartMessage : 'The AI connection service is unavailable. Retry, or quit Opentake completely and reopen it.' };
  } finally { clearTimeout(timer); }
}
