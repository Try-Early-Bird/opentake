import { useEffect, useState } from 'react';
import type { CustomDataSource, DataSnapshot } from '../../../shared/data-sources';
export function useSourceSnapshots(source:Pick<CustomDataSource,'id'|'revision'|'enabled'|'validated'> & {config:{collection:'automatic'|'when-open'|'off';feeds:Array<{id:string}>}}) {
  const [snapshots, setSnapshots] = useState<Record<string, DataSnapshot | null>>({});
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false, running = false, generation = 0, renewed = 0;
    let leases: { feedId: string; leaseId: string }[] = [];
    setSnapshots({}); setError('');
    function release() {
      generation++;
      const ids = leases.map(item => item.leaseId); leases = [];
      if (ids.length) void window.dataSources.release(ids).catch(() => {});
    }
    async function tick() {
      if (disposed || running || document.visibilityState === 'hidden' || !source.enabled || !source.validated || source.config.collection === 'off') return;
      running = true; const current = generation;
      try {
        if (!leases.length) {
          for (const feed of source.config.feeds) {
            const lease = await window.dataSources.acquire({ sourceId: source.id, feedId: feed.id, configVersion: source.revision, schemaVersion: 1 });
            if (disposed || current !== generation) { void window.dataSources.release([lease.leaseId]).catch(() => {}); return; }
            leases.push({ feedId: feed.id, leaseId: lease.leaseId });
          }
          renewed = Date.now();
        }
        const ids = leases.map(item => item.leaseId);
        if (Date.now() - renewed >= 10000) {
          const renewedLeases = await window.dataSources.renew(ids);
          if (disposed || current !== generation) return;
          if (renewedLeases.length !== ids.length) { release(); setSnapshots({}); return; }
          renewed = Date.now();
        }
        const result = await window.dataSources.read(ids);
        if (disposed || current !== generation) return;
        if (result.some(item => !item.snapshot)) { release(); setSnapshots({}); return; }
        setSnapshots(Object.fromEntries(leases.map(lease => [lease.feedId, result.find(item => item.leaseId === lease.leaseId)?.snapshot ?? null])));
        setError('');
      } catch { if (!disposed && current === generation) { release(); setSnapshots({}); setError('Could not read this feed. Retrying while this view is open.'); } }
      finally { running = false; }
    }
    const visible = () => { if (document.visibilityState === 'hidden') { release(); setSnapshots({}); } else void tick(); };
    document.addEventListener('visibilitychange', visible);
    const timer = setInterval(() => void tick(), 2000); void tick();
    return () => { disposed = true; release(); clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [source.id, source.revision, source.enabled, source.validated, source.config.collection]);
  return { snapshots, error };
}
