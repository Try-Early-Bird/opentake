import {ReducePositionsForm} from './ReducePositionsForm';
import { useEffect, useState } from 'react';

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/app-dialog';
import { allocationActions } from './allocation-actions';

// Taking money out while the investment keeps following. Every holding is
// sold in proportion where that can be placed, so the mix does not change and
// the strategy is still being copied with less money in it.
// Where it cannot -- a sleeve too small for its share of the withdrawal to be
// worth selling -- the sells come from the holdings that can be sold, taking
// first from whatever the investment is overweight in, so it ends closer to
// the strategy rather than further from it. The member sees which holdings
// those are in the list below, which is why the list is not a detail.
// The amount still has a floor and a ceiling: a sale has to be worth placing,
// and every holding has to keep enough behind to stay tradable. When the two
// cross there is no amount that works and closing is the only honest answer
// -- the caller does not offer this dialog at all in that case.

export interface RedemptionPreview {
  ok: boolean;
  amount: string;
  band: { minimumAmount: string; maximumAmount: string; possible: boolean; holdingsValue: string };
  legs: { symbol: string; notional: string }[];
  reasons: { code: string; needed?: string }[];
  remainingValue: string;
}

export function ReducePositionsDialog({
  open,
  onOpenChange,
  bucketId,
  accountName,
  currency,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bucketId: string;
  accountName?: string;
  currency: string;
  busy: boolean;
  onConfirm: (amount: string) => Promise<boolean>;
}): React.JSX.Element {
  const [amount, setAmount] = useState('');
  const [preview, setPreview] = useState<RedemptionPreview | null>(null);
  const [error,setError]=useState('');
  const [band, setBand] = useState<RedemptionPreview['band'] | null>(null);

  // The band does not depend on the amount, so it is read once when the dialog
  // opens and stands as a line the member can act on before typing.
  useEffect(() => {
    setBand(null);setError('');
    if (!open) {
      setAmount('');
      setPreview(null);
      return;
    }
    let cancelled = false;
    const actions = allocationActions;
    if (actions === null) return;
    void actions.strategyBuckets.redemptionPreview(bucketId, '1').then((result) => {
      if (!cancelled){if(result.status === 200)setBand((result.redemption as RedemptionPreview).band);else setError('Could not load withdrawal limits. Reopen to retry.');}
    }).catch(()=>{if(!cancelled)setError('Could not load withdrawal limits. Reopen to retry.');});
    return () => {
      cancelled = true;
    };
  }, [open, bucketId]);

  const value = Number(amount);
  useEffect(() => {
    setPreview(null);
    if (!open || !Number.isFinite(value) || value <= 0) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const actions = allocationActions;
    if (actions === null) return;
    const timer = setTimeout(() => {
      void actions.strategyBuckets.redemptionPreview(bucketId, value.toFixed(2)).then((result) => {
        if (!cancelled){setPreview(result.status === 200 ? (result.redemption as RedemptionPreview) : null);if(result.status===200)setBand((result.redemption as RedemptionPreview).band);setError(result.status===200?'':'Could not load the sale preview.');}
      }).catch(()=>{if(!cancelled)setError('Could not load the sale preview.');});
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, bucketId, value, amount]);


  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onOpenChange(false); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Take money out</DialogTitle>
          <DialogDescription>
            Sells a slice of each holding so the mix stays the same. You keep following with less invested.
          </DialogDescription>
        </DialogHeader>
        <ReducePositionsForm accountName={accountName} loading={value>0&&!preview&&!error} amount={amount} onAmountChange={next=>{setPreview(null);setError('');setAmount(next);}} currency={currency} band={band} preview={preview} busy={busy}
          error={error} onCancel={()=>onOpenChange(false)} onConfirm={()=>{void onConfirm(value.toFixed(2));}}
          />
      </DialogContent>
    </Dialog>
  );
}
