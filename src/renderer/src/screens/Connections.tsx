import { CoinbaseConnections } from '../components/CoinbaseConnections';
import { useEffect, useState } from 'react';
import { checkAiConnections } from '../ai-connection-status';
import { GrokMark, OpenaiMark, ClaudeMark, OpencodeMark, OpenrouterMark, LocalModelMark } from '../components/ai-provider-marks';
import type { AiConnectionState } from '../../../shared/ai-connections';
import { RobinhoodLogoTile } from '../logos';
import type { ConnectionSummary } from '../../../shared/connections';

const statusLabels: Record<ConnectionSummary['status'], string> = {
  connected: 'Connected', disconnected: 'Not connected', reauth_required: 'Sign-in required',
};

export function Connections() {
  const [connection, setConnection] = useState<ConnectionSummary>();
  const [ai, setAi] = useState<AiConnectionState[]>();
  const [aiError, setAiError] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const result = await window.connections.status();
        if (active) {
          if (result.ok) { setConnection(result.connection); setError(''); }
          else setError(result.message);
        }
      } catch { if (active) setError('Connection status unavailable.'); }
      if (active) timer = setTimeout(() => void refresh(), 3000);
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, []);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      const result = await checkAiConnections(window.aiConnections);
      if (!active) return;
      if (result.ok) { setAi(result.states); setAiError(''); }
      else { setAi(undefined); setAiError(result.message); }
      timer = setTimeout(() => void refresh(), 3000);
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, []);
  const account = connection?.status === 'connected' && !error
    ? connection.accounts.find(item => item.selected && item.agenticAllowed) : undefined;
  const connectedAi = ai?.filter(item => item.status === 'connected') ?? [];
  const aiLabels = { grok: 'Grok', chatgpt: 'ChatGPT', claude: 'Claude', opencode: 'OpenCode Zen', openrouter: 'OpenRouter', local: 'Local model' };
  const aiMarks = { grok: GrokMark, chatgpt: OpenaiMark, claude: ClaudeMark, opencode: OpencodeMark, openrouter: OpenrouterMark, local: LocalModelMark };
  return <section aria-labelledby="connections-heading" className="space-y-6">
    <h2 id="connections-heading" className="text-lg font-medium">Connections</h2>
    <section aria-labelledby="platform-connections-heading" className="space-y-3">
    <h3 id="platform-connections-heading" className="text-sm font-medium">Trading platforms</h3>
    <div className="flex items-center gap-3 py-3">
      <RobinhoodLogoTile className="size-8 shrink-0 rounded-md" markClassName="size-5" />
      <div className="min-w-0 flex-1"><p className="font-medium">Robinhood</p>{account && <p className="mt-1 text-sm text-muted-foreground">{account.nickname ?? 'Agentic account'} · <span aria-label="Masked account number">{account.maskedNumber}</span></p>}</div>
      <span role="status" className="text-sm text-muted-foreground">{error ? 'Status unavailable' : connection ? statusLabels[connection.status] : 'Loading…'}</span>
    </div>
    <CoinbaseConnections />
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </section>
    <section aria-labelledby="ai-connections-heading" className="space-y-3">
      <h3 id="ai-connections-heading" className="text-sm font-medium">AI</h3>
      {connectedAi.map(item => {
        const Mark = aiMarks[item.provider];
        return <div key={item.provider} className="flex items-center gap-3 py-3">
          <Mark className={`size-6 shrink-0 ${item.provider === 'claude' ? 'text-[#D97757]' : ''}`} />
          <span className="flex-1 font-medium">{aiLabels[item.provider]}</span>
          <span role="status" className="text-sm text-muted-foreground">Connected</span>
        </div>;
      })}
      {aiError ? <p role="alert" className="text-sm text-destructive">{aiError}</p>
        : !ai ? <p role="status" className="text-sm text-muted-foreground">Loading AI connections…</p>
        : !connectedAi.length && !ai.some(item => item.status === 'error') ? <p className="text-sm text-muted-foreground">No AI connected yet.</p> : null}
      {ai?.filter(item => item.status === 'error').map(item => <p key={item.provider} role="alert" className="text-sm text-destructive">{aiLabels[item.provider]}: {item.message ?? 'Connection status unavailable.'}</p>)}
    </section>
  </section>;
}
