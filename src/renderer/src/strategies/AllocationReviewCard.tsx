import { useEffect, useState } from 'react';

import { AlertCard } from '../components/AlertCard';
import { Notice } from '../components/Notice';
import { money, quantity } from '../portfolio/format';
import type { AllocationReview } from '../../../shared/allocations';

// In the panel's own vocabulary: an imported (or restored)
// investment is paused until you have seen what it claims against what the
// account holds now. A member pause
// resumes from the same card once nothing is outstanding.

// One line on why it stopped, so the Resume button is never a mystery.
const PAUSE_REASON_TEXT: Record<NonNullable<AllocationReview['pauseReason']>, string> = {
  imported: 'Paused after import until you confirm it matches your account.',
  restored: 'Paused after a backup restore until you confirm it matches your account.',
  paused_by_you: 'You paused this take. No orders are placed until you resume.',
  loss_limit: 'Paused because it reached its loss limit.',
  account_changed: 'Paused because your account changed outside this take.',
  share_event: 'Paused because the share count changed. Check Robinhood, then decide below.',
};

const BLOCKER_TEXT: Record<string, string> = {
  fills_pending: 'Recent fills are still being matched to your takes. This finishes after the next sync.',
  evidence_stale: 'Sync your account so the review uses current positions and cash.',
  share_event_pending: '',
};

export function AllocationReviewCard({ allocationId, restoreRequired, currency, onChanged, onCloseTake }: {
  allocationId: string;
  restoreRequired: boolean;
  currency: string;
  onChanged: () => void;
  /** Opens the close dialog: the way out when a shortfall cannot be covered. */
  onCloseTake?: () => void;
}): React.JSX.Element | null {
  const [review, setReview] = useState<AllocationReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<AllocationReview>, changed = false): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setReview(await work());
      if (changed) onChanged();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not review this investment.');
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    // A dev app whose preload predates this bridge has no such call; the card is simply not shown.
    if ((window.allocations as typeof window.allocations | undefined) === undefined) return;
    void run(() => window.allocations.review(allocationId));
  }, [allocationId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (review === null) {
    return error === null ? null : <Notice tone="error" title="Review unavailable" text={error} />;
  }
  if (review.status === 'active') return null;

  const resume = { label: busy ? 'Resuming…' : 'Resume take', onClick: () => void run(() => window.allocations.resume(allocationId), true), disabled: busy || !review.ready };
  // An older background host sends no share changes.
  const shareEvents = review.shareEvents ?? [];
  const blocker = review.blockers.map((code) => BLOCKER_TEXT[code] ?? code).filter(Boolean).join(' ');

  return (
    <>
      {review.cases.map((item) => item.cause === 'negative_subledger_balance' ? (
        // Hosted's operator correction, done by the member: the take paid for an order partly
        // with your own cash, and covering records that cash as put in. Nothing is traded.
        <AlertCard
          key={item.id}
          title={(item.oversold ?? []).length > 0 ? 'This take sold more shares than it held' : 'This take spent more cash than it held'}
          source="This take's own records"
          value={item.difference === null ? null : money(`-${item.difference}`, currency)}
          rows={[
            ...(item.claimed === null ? [] : [{ label: 'Take cash', value: money(item.claimed, currency), accent: true }]),
            ...(item.oversold ?? []).map((sold) => ({ label: `${sold.symbol ?? 'Shares'} sold beyond holdings`, value: `${quantity(sold.quantity)} shares`, accent: true })),
          ]}
          footnote={item.canCover === true
            ? `An order this take placed was paid for partly from your own cash in the same account. Covering records ${money(item.difference ?? '0', currency)} as money you put in, so the take continues. Nothing is bought, sold or moved.`
            : (item.oversold ?? []).length > 0
              ? 'The extra shares came out of your own holding, so this cannot be covered with cash. Close the take to settle it.'
              : 'The take is no longer short. Review again to continue.'}
          primary={item.canCover === true
            ? { label: busy ? 'Saving…' : `Cover ${money(item.difference ?? '0', currency)}`, onClick: () => void run(() => window.allocations.coverShortfall(allocationId, item.id), true), disabled: busy }
            : undefined}
          secondary={onCloseTake === undefined ? undefined : { label: 'Close take', onClick: onCloseTake, disabled: busy }}
        />
      ) : (
        <AlertCard
          key={item.id}
          title={!['cash_shortfall', 'position_shortfall'].includes(item.cause)
            // A fill the take's books could not match yet (missing evidence).
            ? `A ${item.symbol ?? 'recent'} fill is not matched yet`
            : item.symbol === null ? 'Cash is short of what this investment holds' : `${item.symbol} is short of what this investment holds`}
          source={item.cause === 'missing_order_causation' ? 'An order placed outside Opentake' : 'Your Robinhood account, at the last sync'}
          value={item.difference === null ? null : item.symbol === null ? money(item.difference, currency) : quantity(item.difference)}
          rows={[
            ...(item.claimed === null ? [] : [{ label: 'Investment holds', value: item.symbol === null ? money(item.claimed, currency) : `${quantity(item.claimed)} shares` }]),
            ...(item.observed === null ? [] : [{ label: 'Account has', value: item.symbol === null ? money(item.observed, currency) : `${quantity(item.observed)} shares` }]),
            ...(item.yourShare === null ? [] : [{ label: 'From this investment', value: item.symbol === null ? money(item.yourShare, currency) : `${quantity(item.yourShare)} shares`, accent: true }]),
          ]}
          footnote={item.canKeepReduced
            ? 'Keep the smaller amount to continue: the investment will hold only what the account still has.'
            : 'This needs the order to be matched before the investment can continue.'}
          primary={item.canKeepReduced ? { label: busy ? 'Saving…' : 'Keep reduced', onClick: () => void run(() => window.allocations.keepReduced(allocationId, item.id), true), disabled: busy } : undefined}
        />
      ))}
      {shareEvents.map((event) => {
        const held = review.positions.find((p) => p.symbol === event.symbol)?.claimed ?? null;
        const split = event.kind === 'split' && event.splitTo !== null && event.splitFrom !== null;
        const after = split && held !== null ? String(Number(held) * event.splitTo! / event.splitFrom!) : null;
        const on = new Date(`${event.effectiveOn}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
        return (
          <AlertCard
            key={event.id}
            title={split ? `${event.symbol} had a ${event.splitTo}-for-${event.splitFrom} reverse split` : `${event.symbol}'s share count may have changed`}
            source={`Robinhood's prices, effective ${on}`}
            rows={[
              ...(held === null ? [] : [{ label: 'Investment holds', value: `${quantity(held)} shares` }]),
              ...(after === null ? [] : [{ label: 'After the split', value: `${quantity(after)} shares`, accent: true }]),
            ]}
            footnote={split
              ? 'Check your shares in Robinhood. Apply if they match the split; Robinhood may pay cash for a fraction of a share, and the account review settles that. Dismiss if your share count did not change.'
              : 'This is not a simple split. Check your shares in Robinhood and dismiss to continue; if they changed, the account review shows the difference.'}
            primary={split
              ? { label: busy ? 'Saving…' : 'Apply split', onClick: () => void run(() => window.allocations.decideShareEvent(allocationId, event.id, 'apply'), true), disabled: busy }
              : { label: busy ? 'Saving…' : 'Nothing changed, continue', onClick: () => void run(() => window.allocations.decideShareEvent(allocationId, event.id, 'dismiss'), true), disabled: busy }}
            secondary={split ? { label: 'Dismiss', onClick: () => void run(() => window.allocations.decideShareEvent(allocationId, event.id, 'dismiss'), true), disabled: busy } : undefined}
          />
        );
      })}
      {review.cases.length === 0 && shareEvents.length === 0 && (
        <Notice
          tone={review.ready ? 'scheduled' : 'retry'}
          title={restoreRequired ? (review.ready ? 'Ready to resume' : 'Review before resuming') : 'Paused'}
          text={[review.pauseReason === null ? '' : PAUSE_REASON_TEXT[review.pauseReason], review.ready ? '' : blocker].filter(Boolean).join(' ') || undefined}
          action={resume}
          actionBelow
        />
      )}
      {error !== null && <p className="mt-2 text-xs text-error">{error}</p>}
    </>
  );
}
