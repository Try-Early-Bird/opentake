import { Lock } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useRouterState } from '@tanstack/react-router';

import { Button } from './ui/button';
import { ClosePositionsDialog, type SellChoice } from './ClosePositionsDialog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/app-dialog';
import { allocationActions } from '../strategies/allocation-actions';
import { followData, type HoldingWithPnl } from '../strategies/follow-data';
import { setArchivePromptOpen, useArchivePromptOpen } from '../archive-decision-store';

// The member archives their own take (from the chat list or the take page), and
// each investment in it waits for them to hold or sell (migration 41). One
// row per undecided investment with Hold all, Sell all, and Choose, which
// opens the per-position table. It opens on its own the first time the app
// finds an undecided investment in a session; "Decide later" closes it, and
// the take page and the bell keep the decision until it is made, and the
// bell's Choose raises it again (archive-decision-store). The local
// holdings are read again when raised, on navigation, focus and once a minute.

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const RELOAD_MS = 60_000;

function undecided(holding: HoldingWithPnl): boolean {
  return holding.closure?.reason === 'archive' && holding.closure.status === 'awaiting';
}

export function ArchiveDecisionPrompt(): React.JSX.Element | null {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const requested = useArchivePromptOpen();
  const [holdings, setHoldings] = useState<HoldingWithPnl[]>([]);
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    const result = await followData.getStrategyHoldings().catch(() => null);
    if (result?.status === 200) setHoldings(result.holdings);
  }, []);

  useEffect(() => { void reload(); }, [reload, pathname, requested]);
  useEffect(() => {
    const onFocus = (): void => { void reload(); };
    window.addEventListener('focus', onFocus);
    const timer = setInterval(onFocus, RELOAD_MS);
    return () => { window.removeEventListener('focus', onFocus); clearInterval(timer); };
  }, [reload]);

  const pending = holdings.filter(undecided);

  // Opens on its own for an investment it has not asked about yet this session.
  useEffect(() => {
    const fresh = pending.filter((holding) => !seen.has(holding.bucket.id));
    if (fresh.length === 0) return;
    setSeen((current) => new Set([...current, ...fresh.map((holding) => holding.bucket.id)]));
    setOpen(true);
  }, [pending, seen]);

  const decide = async (bucketId: string, sell: SellChoice): Promise<void> => {
    if (busy !== null || allocationActions === null) return;
    setBusy(bucketId);
    setError(null);
    const result = await allocationActions.strategyBuckets.close(bucketId, sell);
    setBusy(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setChoosing(null);
    await reload();
  };

  const close = (): void => { setOpen(false); setArchivePromptOpen(false); };
  if (!(open || requested) || pending.length === 0) return null;
  const choosingHolding = choosing === null ? null : pending.find((holding) => holding.bucket.id === choosing) ?? null;

  return (
    <>
      <Dialog open={choosingHolding === null} onOpenChange={(next) => { if (!next) close(); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Lock size={16} className="text-muted-foreground" /> You archived a take you invest in</DialogTitle>
            <DialogDescription>
              Trading is paused until you decide. Hold keeps the shares in your account outside this Take. Sell places market
              sell orders and keeps the proceeds in your account. Choose lets you decide which holdings to sell.
            </DialogDescription>
          </DialogHeader>
          <ul className="divide-y divide-border">
            {pending.map((item) => (
              <li key={item.bucket.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm row-title">{item.strategy.displayName}</p>
                  {item.closure?.openedAt !== undefined && (
                    <p className="mt-0.5 text-xs text-muted-foreground">Archived {dateFormat.format(new Date(item.closure.openedAt))}</p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void decide(item.bucket.id, 'none')}>
                    {busy === item.bucket.id ? '…' : 'Hold all'}
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void decide(item.bucket.id, 'all')}>
                    Sell all
                  </Button>
                  <Button size="sm" disabled={busy !== null} onClick={() => setChoosing(item.bucket.id)}>
                    Choose
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {error !== null && <p className="text-xs text-error">{error}</p>}
          <div className="flex justify-end">
            <Button size="sm" variant="ghost" onClick={close}>Decide later</Button>
          </div>
        </DialogContent>
      </Dialog>
      {choosingHolding !== null && (
        <ClosePositionsDialog
          holding={choosingHolding}
          open
          title={`Close ${choosingHolding.strategy.displayName}`}
          description="Tick the positions to sell at market. Everything else stays in your account as your own shares."
          busy={busy !== null}
          error={error}
          onClose={() => setChoosing(null)}
          onConfirm={(sell) => void decide(choosingHolding.bucket.id, sell)}
        />
      )}
    </>
  );
}
