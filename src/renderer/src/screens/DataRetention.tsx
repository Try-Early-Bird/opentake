import { useEffect, useState } from 'react';
import { Select } from '../components/ui/select';

const logRetention = {load:()=>window.settings.logRetention(),save:(days:number|null)=>window.settings.setLogRetention(days!)};

const jobRetention = { load: () => window.settings.jobRetention(), save: (days: number | null) => window.settings.setJobRetention(days) };
const financialRetention = { load: () => window.settings.financialRetention(), save: (days: number | null) => window.settings.setFinancialRetention(days) };
const auditRetention = { load: () => window.settings.aiAuditRetention(), save: (days: number | null) => window.settings.setAiAuditRetention(days) };

const DEFAULT_ITEMS = [
  { value: '7', label: '7 days' }, { value: '30', label: '30 days' },
  { value: '90', label: '90 days' }, { value: 'forever', label: 'Forever' },
];

function RetentionControl({ id, label, description, storage, items = DEFAULT_ITEMS }: {
  id: string; label: string; description: string; items?: { value: string; label: string }[];
  storage: { load(): Promise<number | null>; save(days: number | null): Promise<number | null> };
}) {
  const [value, setValue] = useState('forever');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void storage.load().then(days => {
      if (active) { setValue(days === null ? 'forever' : String(days)); setLoaded(true); setError(''); }
    }).catch(() => { if (active) setError('Could not load retention settings.'); });
    return () => { active = false; };
  }, [attempt, storage]);
  async function save(next: string) {
    if (saving || next === value) return;
    const previous = value;
    setValue(next);
    setSaving(true); setError(''); setMessage('');
    try {
      const days = await storage.save(next === 'forever' ? null : Number(next));
      setValue(days === null ? 'forever' : String(days));
      setMessage('Retention saved.');
    } catch {
      setValue(previous);
      setError('Could not save retention. Your previous setting is unchanged. Try selecting again.');
    }
    finally { setSaving(false); }
  }
  return <div className="space-y-3">
    <label htmlFor={id} className="block text-sm font-medium">{label}</label>
    <Select id={id} value={value} disabled={!loaded || saving} onValueChange={next => void save(next)} items={items} />
    <p className="text-sm text-muted-foreground">{description}</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {(saving || message) && <p role="status" className="text-sm text-muted-foreground">{saving ? 'Saving…' : message}</p>}
    {!loaded && error && <button onClick={() => setAttempt(value => value + 1)} className="rounded-md border border-input px-3 py-2 text-sm">Retry</button>}
  </div>;
}

export function DataRetention() {
  return <section aria-labelledby="data-retention-settings" className="space-y-6">
    <h2 id="data-retention-settings" className="text-lg font-medium">Data Retention</h2>
    <p className="text-sm text-muted-foreground">Changes save automatically. Choosing a shorter period permanently deletes records older than that period immediately. Opentake also checks for old records at startup and hourly when the background service is idle.</p>
    <RetentionControl id="log-retention" label="Keep system logs" storage={logRetention} items={[1,7,14,30,90].map(days=>({value:String(days),label:`${days} ${days===1?'day':'days'}`}))} description="App and background diagnostic logs. Defaults to 30 days, with daily files and automatic cleanup as logs are written. Shortening this period deletes older days immediately." />
    <RetentionControl id="job-retention" label="Keep job history" storage={jobRetention}
      description="Completed and cancelled jobs and their execution logs are automatically deleted after this period. Active jobs and unresolved failures are kept." />
    <RetentionControl id="financial-retention" label="Keep account history" storage={financialRetention}
      items={[{ value: '90', label: '90 days' }, { value: '366', label: '1 year' }, { value: 'forever', label: 'Forever' }]}
      description="Balance and holding history used in portfolio charts. Older records are deleted unless needed by a Take: history since it started, records supporting its allocations, and unresolved account differences or dividend reinvestments." />
    <RetentionControl id="ai-audit-retention" label="Keep AI audits" storage={auditRetention}
      description="AI audits include captured inputs, outputs, tool activity and approvals. Finished audits and their recorded steps are deleted after this period, measured from completion. Active audits and your conversations are kept." />
  </section>;
}
