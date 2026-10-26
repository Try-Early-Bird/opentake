import { useEffect, useRef, useState } from 'react';
import type { SearchAgentAPI } from '../../shared/search-agent';

type Snapshot = Awaited<ReturnType<SearchAgentAPI['snapshot']>>;
export function useSearchAgent(question: string, sources: string[]) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [starting, setStarting] = useState(false), [error, setError] = useState('');
  const generation = useRef(0), run = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const scope = JSON.stringify(sources);
  useEffect(() => {
    setSnapshot(null); setStarting(false); setError('');
    return () => { generation.current++; clearTimeout(timer.current); const id = run.current; run.current = null; if (id) void window.searchAgent.stop(id).catch(() => {}); };
  }, [question, scope]);
  async function start(savedId?: string) {
    if (starting || snapshot?.state === 'running') return;
    const version = ++generation.current; clearTimeout(timer.current); setStarting(true); setError(''); setSnapshot(null);
    try {
      const id = savedId ? await window.searchAgent.replay(savedId) : await window.searchAgent.start({ question, sources });
      if (generation.current !== version) { void window.searchAgent.stop(id).catch(() => {}); return; }
      run.current = id;
      const poll = async () => {
        try {
          const value = await window.searchAgent.snapshot(id);
          if (generation.current !== version) return;
          setSnapshot(value);
          if (value.state === 'running') timer.current = setTimeout(() => void poll(), 250);
        } catch { if (generation.current === version) { setError('Could not read the agent search. Try again.'); void window.searchAgent.stop(id).catch(() => {}); } }
      };
      await poll();
    } catch { if (generation.current === version) setError(savedId ? 'Could not replay this saved screen. Check its original venue/account and search permissions.' : 'Could not start search AI. Check the selected model, connected venues, and search permissions.'); }
    finally { if (generation.current === version) setStarting(false); }
  }
  async function stop() { if (starting && !run.current) { generation.current++; setStarting(false); return; } if (run.current) try { await window.searchAgent.stop(run.current); } catch { setError('Could not stop search. Try again.'); } }
  async function decide(id: string, allow: boolean) {
    if (run.current) try { await window.searchAgent.decide(run.current, id, allow); } catch { setError('Approval expired or could not be saved.'); }
  }
  return { snapshot, starting, error, start, stop, decide, busy: starting || snapshot?.state === 'running' };
}
