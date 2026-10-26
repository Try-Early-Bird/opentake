import { useEffect, useState } from 'react';

export { freshCoinbaseTrade } from '../../../shared/coinbase-live-price';
import { freshCoinbaseTrade } from '../../../shared/coinbase-live-price';

export function useCoinbaseLivePrice(product: string): string | null {
  const [value, setValue] = useState<{ product: string; price: string | null }>({ product, price: null });
  useEffect(() => {
    let disposed = false, running = false, leaseId: string | undefined, renewAt = 0, epoch = 0;
    const api = window.dataSources.coinbaseStream;
    const clear = () => setValue({ product, price: null });
    clear();
    function release() {
      epoch++;
      const id = leaseId; leaseId = undefined;
      if (id) void api.release([id]).catch(() => {});
    }
    async function tick() {
      if (disposed || running || document.visibilityState === 'hidden') return;
      running = true;
      const generation = epoch;
      try {
        if (!leaseId) {
          const lease = await api.acquire(product);
          if (disposed || generation !== epoch) { await api.release([lease.leaseId]); return; }
          leaseId = lease.leaseId; renewAt = Date.now() + lease.renewAfterMs;
        }
        if (Date.now() >= renewAt) {
          const renewed = await api.renew([leaseId]);
          if (disposed || generation !== epoch) return;
          if (!renewed.length) { release(); clear(); return; }
          renewAt = Date.now() + renewed[0].renewAfterMs;
        }
        const reads = await api.read([leaseId]);
        if (disposed || generation !== epoch) return;
        const snapshot = reads[0]?.snapshot ?? null;
        setValue({ product, price: freshCoinbaseTrade(snapshot, product, Date.now()) });
        if (!snapshot) release();
      } catch { if (!disposed && generation === epoch) clear(); }
      finally { running = false; }
    }
    function visibility() {
      if (document.visibilityState === 'hidden') { release(); clear(); }
      else void tick();
    }
    void tick();
    const timer = setInterval(() => void tick(), 1000);
    document.addEventListener('visibilitychange', visibility);
    return () => { disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', visibility); release(); };
  }, [product]);
  return value.product === product ? value.price : null;
}
