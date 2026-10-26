import {hasPendingInvestment} from '../../../shared/investment-status';
import {RobinhoodVersionPanel} from './RobinhoodVersionPanel';
import {TakeMoneyOutMenu} from './TakeMoneyOutMenu';
import {InvestmentControls} from './InvestmentControls';
import {TakeAccountPlan} from './TakeAccountPlan';
import {InvestmentSummary} from './InvestmentSummary';
import {FailedInvestment} from './FailedInvestment';
import { InvestmentAmountForm } from './InvestmentAmountForm';
import { Button } from '../components/ui/button';
import { cn } from '../lib/utils';
import { money, quantity, signedMoney, signedPercent } from '../portfolio/format';
import type { PortfolioAccount } from '../portfolio/types';
import { Link } from '@tanstack/react-router';
import { CircleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { ClosePositionsDialog, type SellChoice } from '../components/ClosePositionsDialog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/app-dialog';
import { activeStrategyHoldings, closureNeedsDecision, freeBuyingPower, type SelfDirectedAccount } from './holdings';
import { followData, type HoldingWithPnl } from './follow-data';
import { allocationActions } from './allocation-actions';
import { AllocationReviewCard } from './AllocationReviewCard';
import { PreflightSummary, usePreflight } from './PreflightSummary';
import { ReducePositionsDialog, type RedemptionPreview } from './ReducePositionsDialog';
import { HoldingLogo, useLogos } from '../components/HoldingLogo';
import { StrategyActivityPanel } from './StrategyActivityPanel';
import { useToast } from '../components/ui/action-toast';
import type { AllocationHistory } from '../../../shared/portfolio';
import { whenLabel } from '../when-label';
import { noteQueueActed, setWaitingOpen, useQueueVersion } from '../waiting-store';
import { InstructionCard, type StrategyInstruction } from './InstructionCard';
import { AlertCard, type AlertRow } from '../components/AlertCard';
import { Notice } from '../components/Notice';

// The strategy page's side panel: the member's own stake in this strategy.
// Following: bucket value, return since joining, a small value chart, and
// pause/resume. Not following: an amount at or above the follower floor and
// a Follow button, which creates the bucket and activates it. Drafts explain
// that publishing comes first.

// Self-hosted: the investment is a local allocation (follow-data.ts), and
// trading goes through allocationActions (window.allocations).

interface PlanSleeve {
  symbol: string;
  targetWeightPercent: number;
  currentWeightPercent: number;
  currentValueUsd: string;
  disposition: 'order' | 'skip' | 'defer';
  side: 'buy' | 'sell' | null;
  amount: string | null;
  reason: string | null;
}

/** The provider's smallest order; below it there is nothing to buy back. */
const MINIMUM_ORDER_USD = 1;

const sleeveReason: Record<string, string> = {
  within_rebalance_threshold: 'on target',
  below_minimum_order: 'under the $1 order minimum',
  insufficient_bucket_cash: 'waiting for cash',
  order_notional_limit: 'over the order cap',
  missing_mark_price: 'no price yet',
  insufficient_attributed_quantity: 'shares not attributed',
};

/** Why a leg failed, in the member's terms; the code itself is the fallback. */
function failureLabel(code: string): string {
  if (code === 'placement_not_found') return 'Robinhood never confirmed the order';
  // The self-hosted order writer's codes (orders/service.ts, execution/executor.ts).
  if (code === 'provider_invalid_request') return 'Robinhood refused the order';
  if (code === 'review_expired') return 'the order review expired before it was placed';
  if (code === 'stale_plan') return 'the order was never sent and was cleared';
  if (code === 'member_abandoned') return 'you cleared it after checking Robinhood';
  if (code === 'delegated_robinhood_order_intent_conflict') return 'the order review expired before it was placed';
  if (code.startsWith('delegated_robinhood_vault') || code.startsWith('delegated_')) return 'Robinhood rejected the order request';
  if (code.startsWith('provider_')) return `Robinhood ${code.slice('provider_'.length)} the order`;
  return `the order failed (${code})`;
}

/** Why a close's sells did not go through (planner reason or the failed leg's code). */
function closureFailureText(code: string | null): string {
  if (code === null) return 'The sells could not be placed.';
  if (code === 'nothing_to_sell') return 'This take holds none of the chosen positions any more.';
  return `The sell did not go through: ${failureLabel(code)}.`;
}

type Instruction = StrategyInstruction;

function timeLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function sinceLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "AMZN, NVDA and TSLA": symbols as a sentence would say them. */
function listSymbols(symbols: readonly string[]): string {
  if (symbols.length <= 1) return symbols.join('');
  return `${symbols.slice(0, -1).join(', ')} and ${symbols[symbols.length - 1]}`;
}

type FollowPanelProps = {
  takeId?: string;
  strategyId: string;
  published: boolean;
  /** Follower floor in USD, null until the strategy has holdings. */
  minimumAllocation: number | null;
  mixedDeposit?:()=>void;
  onChanged?: () => void;
};

/** Confirmation toasts live in AppShell so panel refreshes cannot dismiss them. */
export function FollowPanel(props: FollowPanelProps): React.JSX.Element {
  return <FollowPanelContent {...props} />;
}

function FollowPanelContent({ takeId, strategyId, published, minimumAllocation, onChanged, mixedDeposit }: FollowPanelProps): React.JSX.Element {
  const actions = allocationActions;
  const [holdings, setHoldings] = useState<HoldingWithPnl[] | null>(null);
  // Cash the member's strategies hold, per account: not theirs to invest again.
  const [selfDirected, setSelfDirected] = useState<SelfDirectedAccount[] | null>(null);
  const [account, setAccount] = useState<PortfolioAccount | null>(null);
  const [history, setHistory] = useState<AllocationHistory | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState<'follow' | 'close' | 'deposit' | 'retry' | 'reduce' | 'keep' | 'instruction' | 'confirm' | null>(null);
  const [instructions, setInstructions] = useState<Instruction[]>([]);
  const [instructionsLoadedFor,setInstructionsLoadedFor]=useState<string|null>(null);
  // Whether the member confirms every trade: the toasts after investing,
  // depositing or withdrawing must not promise orders are going out.
  const [confirmTrades, setConfirmTrades] = useState(false);
  // Buying back shares an outside sale took: the deposit dialog opens with
  // the amount filled in, after the investment has been told to keep following.
  const [restoring, setRestoring] = useState<{ symbol: string; shares: string } | null>(null);
  const [splitting, setSplitting] = useState(false);
  // A restore spends the member's cash, so the button asks once before it does.
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  // Cash cannot be restored from here: it has to come back into Robinhood,
  // and the check that resumes the investment runs on its own.
  const [waitingForTransfer, setWaitingForTransfer] = useState(false);
  const [splittingCash, setSplittingCash] = useState(false);
  const [closing, setClosing] = useState(false);
  // Taking money out and closing are different decisions, so the member is
  // asked which one first rather than being dropped into the sell-or-hold
  // table: reducing keeps the strategy, closing ends it.
  const [choosing, setChoosing] = useState(false);
  const [reducing, setReducing] = useState(false);
  const [canReduce, setCanReduce] = useState<boolean | null>(null);
  const [depositOpen, setDepositOpen] = useState(false);
  const [depositAmount, setDepositAmount] = useState('');
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [failedInvestment,setFailedInvestment]=useState<{amount:string;accountName:string;message:string;assets:{symbol:string;bps:number;notional:string}[]}|null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void followData.getStrategyHoldings().then((result) => {
      if (cancelled) return;
      // A refresh that fails keeps what the last one found: an empty list
      // would read as "not invested", offer Invest on a strategy the member
      // follows, and stop the refresh that would have corrected it.
      if (result.status !== 200) {
        setHoldings((current) => current ?? []);
        return;
      }
      setHoldings(result.holdings as HoldingWithPnl[]);
      setSelfDirected(result.selfDirected as SelfDirectedAccount[]);
    });
    void followData.getPortfolio().then((data) => {
      if (!cancelled) setAccount((data ?? null) as PortfolioAccount | null);
    });
    return () => {
      cancelled = true;
    };
  }, [strategyId, reload]);

  const mine = useMemo(
    () => (holdings === null ? null : activeStrategyHoldings(holdings).find((holding) => holding.strategy.id === strategyId) as HoldingWithPnl | undefined ?? null),
    [holdings, strategyId],
  );
  // Share counts this bucket holds per symbol, alphabetical; the invested
  // amount is implied by the value and return. Logos come from the market catalog.
  const shares = useMemo(() => (mine?.positions ?? [])
    .filter((position) => Number(position.quantity) > 0)
    .sort((left, right) => left.symbol.localeCompare(right.symbol)), [mine]);
  const shareSymbols = useMemo(() => shares.map((position) => position.symbol), [shares]);
  const logos = useLogos(shareSymbols);

  // Withdrawals still waiting or selling: a queued one can be cancelled until its sells go out.
  const bucketId = mine?.bucket.id ?? null;
  useEffect(() => {
    setInstructionsLoadedFor(null);
    if (bucketId === null) {
      setInstructions([]);
      return;
    }
    let cancelled = false;
    // A dev app whose preload predates this bridge has no such call; the row is simply not shown.
    const list = actions?.strategyBuckets.instructions;
    if (list === undefined) return;
    void list(bucketId).then((result) => {
      if (!cancelled&&result.status===200) {setInstructions(result.instructions as Instruction[]);setInstructionsLoadedFor(bucketId);}
    }).catch(()=>{});
    return () => {
      cancelled = true;
    };
  }, [bucketId, reload]);

  useEffect(() => {
    let cancelled = false;
    void actions?.tradingPreferences.get().then((result) => {
      if (!cancelled && result.ok) setConfirmTrades(result.preferences.confirmTrades);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [reload]);
  // What the member just asked for, when it will wait for their OK first.
  const heldToast = (title: string): void => {
    toast.add({
      title,
      description: `${mine?.strategy.displayName ?? 'This investment'} · Waiting for your OK. Confirm it in your queue to place the orders.`,
      data: { icon: 'scheduled' },
      actionProps: { children: 'View', onClick: () => setWaitingOpen(true) },
    });
  };

  // A different case, or none at all: the confirm state does not carry over.
  useEffect(() => {
    setConfirmingRestore(false);
  }, [mine?.outsideSale?.caseId]);

  useEffect(() => {
    if (mine === null) {
      setHistory(null);
      return;
    }
    let cancelled = false;
    void followData.getStrategyBucketHistory(mine.bucket.id, 'all').then((result) => {
      if (!cancelled) setHistory(result.status === 200 ? result.history : null);
    });
    return () => {
      cancelled = true;
    };
  }, [mine]);

  useEffect(() => {
    if (amount === '' && minimumAllocation !== null) setAmount(String(minimumAllocation));
  }, [minimumAllocation]); // eslint-disable-line react-hooks/exhaustive-deps

  const currency = account?.summary.currency ?? 'USD';
  // What the typed amount would buy, from the server's own sizing.
  const investPreflight = usePreflight({ strategyId }, amount, mine === null);
  // The floor needs no request: it is the provider's smallest order over the
  // smallest holding, and the invest floor already carries that arithmetic
  // with its activation headroom, which money added to an existing investment
  // does not need. Shown as a standing line so it is there before typing.
  const depositMinimum = minimumAllocation === null ? null : Math.ceil(minimumAllocation / 2);
  // Holdings the strategy has and this investment does not, with nothing
  // working on them: their share of the member's money is sitting as cash.
  const missingHoldings = mine?.replication?.state === 'replication_limited'
    ? mine.replication.missingSymbols
    : [];
  // Orders the strategy has out right now. Nothing else may run while they
  // are open -- the worker refuses to plan, and closing waits for them -- so
  // the panel says so rather than letting a member press and be refused.
  const working = (mine?.openExecutions ?? 0) > 0;
  // Whether any amount could come out at all: too small an investment has a
  // floor above its ceiling, and then closing is the only honest option.
  useEffect(() => {
    if (mine === null || !choosing || actions === null) return;
    let cancelled = false;
    void actions.strategyBuckets.redemptionPreview(mine.bucket.id, '1').then((result) => {
      if (cancelled) return;
      const band = result.status === 200 ? (result.redemption as RedemptionPreview).band : null;
      setCanReduce(band?.possible ?? false);
    });
    return () => {
      cancelled = true;
    };
  }, [mine, choosing]);
  // Of the missing holdings, the ones Robinhood will not trade right now: the
  // strategy passed them over on purpose and buys them when it can again.
  const untradableMissing = mine?.replication?.untradableSymbols ?? [];

  // While orders are working, look again shortly: they settle on their own and
  // the panel should stop saying "placing" without the member doing anything.
  // A live instruction card (queued, held for a confirmation, waiting for the
  // open) is looked at less often, and at once when the queue window acts.
  // One still being planned turns into orders within seconds, and whether
  // they wait for the member's OK is what they need to see, so it is looked at
  // as often as working orders.
  const hasLiveInstruction = hasPendingInvestment(instructions);
  const planning = instructions.some((instruction) => instruction.status === 'pending' && instruction.pendingReason === 'requested');
  useEffect(() => {
    if (!working && !hasLiveInstruction) return;
    const timer = setTimeout(() => setReload((key) => key + 1), working || planning ? 5_000 : 15_000);
    return () => clearTimeout(timer);
  }, [working, hasLiveInstruction, planning, reload]);
  const queueVersion = useQueueVersion();
  const seenQueueVersion = useRef(queueVersion);
  useEffect(() => {
    if (queueVersion === seenQueueVersion.current) return;
    seenQueueVersion.current = queueVersion;
    setReload((key) => key + 1);
  }, [queueVersion]);
  const depositPreflight = usePreflight(
    mine === null ? { strategyId } : { bucketId: mine.bucket.id },
    depositAmount,
    mine !== null && depositOpen,
  );
  // What the member can put in: Robinhood's buying power (cash when it is not
  // reported) less the cash their strategies already hold, as on the
  // Portfolio screen.
  const buyingPower = freeBuyingPower(
    account?.summary.buyingPower ?? account?.summary.cash,
    selfDirected?.find((entry) => entry.accountId === account?.accountId)?.reservedCash,
  );

  const recordInvestmentFailure=(message:string,value:string)=>setFailedInvestment({amount:value,accountName:account?.maskedNumber||'Robinhood account',message,assets:(investPreflight?.legs??[]).map(leg=>({symbol:leg.symbol,bps:leg.weightPercent*100,notional:leg.notional}))});

  const follow = async (): Promise<void> => {
    if (account === null || actions === null) return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setError('Enter an amount.');
      return;
    }
    if (minimumAllocation !== null && value < minimumAllocation) {
      setError(`At least ${money(minimumAllocation)} so every position clears Robinhood’s $1 order.`);
      return;
    }
    setBusy('follow');
    setError(null);
    const created = await actions.strategyBuckets.create({
      strategyId,
      financialAccountId: account.accountId,
      allocationValue: value.toFixed(2),
      confirmationMode: 'delegated',
    });
    if (!created.ok) {
      setBusy(null);
      setError(created.message);
      if(['insufficient_cash','account_unavailable','snapshot_required','allocation_exceeds_account','allocation_below_minimum','preflight_failed','symbol_blocked'].includes(created.code??''))recordInvestmentFailure(created.message,value.toFixed(2));
      else setFailedInvestment(null);
      return;
    }
    const bucketId = (created.body as { id?: string }).id;
    const activated = bucketId === undefined
      ? { ok: false as const, message: 'Bucket was created but not returned.' }
      : await actions.strategyBuckets.update(bucketId, { status: 'active' });
    setBusy(null);
    if (!activated.ok) {
      setError(activated.message);
      if('code' in activated&&activated.code==='preparation_failed')recordInvestmentFailure(activated.message,value.toFixed(2));
      else setFailedInvestment(null);
    } else if (confirmTrades) {
      heldToast(`Invest ${money(value.toFixed(2), currency)}`);
    }
    if (activated.ok) {setFailedInvestment(null);noteQueueActed();}
    setReload((key) => key + 1);
    onChanged?.();
  };

  const closeInvestment = async (sell: SellChoice): Promise<void> => {
    if (mine === null || actions === null) return;
    setBusy('close');
    setError(null);
    const result = await actions.strategyBuckets.close(mine.bucket.id, sell);
    setBusy(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setClosing(false);
    setReload((key) => key + 1);
    onChanged?.();
  };

  const reduce = async (amount: string): Promise<boolean> => {
    if (mine === null || actions === null) return false;
    setBusy('reduce');
    setError(null);
    const result = await actions.strategyBuckets.redeem(mine.bucket.id, amount);
    setBusy(null);
    if (!result.ok) {
      setError(result.message);
      return false;
    }
    setReducing(false);
    // A withdrawal that has to wait (shares bought today settle first) is
    // queued and runs by itself; saying it is selling now would be untrue.
    const instruction = (result.body as { instruction?: { status?: string; expectedAt?: string | null } | null })
      .instruction;
    noteQueueActed();
    if (confirmTrades && instruction?.status !== 'pending') {
      heldToast(`Withdraw ${money(amount, currency)}`);
    }
    setReload((key) => key + 1);
    onChanged?.();
    return true;
  };

  const answerInstruction = async (instruction: Instruction, action: 'cancel' | 'confirm'): Promise<void> => {
    if (mine === null || actions === null) return;
    setBusy('instruction');
    setError(null);
    const result = action === 'cancel'
      ? await actions.strategyBuckets.cancelInstruction(mine.bucket.id, instruction.id)
      : await actions.strategyBuckets.confirmInstruction(mine.bucket.id, instruction.id);
    setBusy(null);
    if (!result.ok) {
      setError(result.message);
    } else if (action === 'cancel') {
      toast.add({ title: ['subscription','contribution'].includes(instruction.kind)?`Cancelled: ${money(instruction.requestedAmount ?? '0', currency)} returned to Robinhood buying power.`:`Cancelled: nothing of the ${money(instruction.requestedAmount ?? '0', currency)} will be sold.` });
    }
    setReload((key) => key + 1);
    onChanged?.();
  };

  const deposit = async (): Promise<void> => {
    if (mine === null || actions === null) return;
    const value = Number(depositAmount);
    if (!Number.isFinite(value) || value <= 0) {
      setError('Enter an amount.');
      return;
    }
    setBusy('deposit');
    setError(null);
    const result = await actions.strategyBuckets.deposit(mine.bucket.id, value.toFixed(2));
    setBusy(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setDepositOpen(false);
    setDepositAmount('');
    noteQueueActed();
    // Whether the orders go out now or at the open, the deposit is queued
    // until they do and can be cancelled from the card or the waiting window.
    if (confirmTrades && restoring === null) {
      heldToast(`${money(value.toFixed(2), currency)} deposit`);
      setReload((key) => key + 1);
      onChanged?.();
      return;
    }
    setRestoring(null);
    setReload((key) => key + 1);
    onChanged?.();
  };

  /**
   * Answers an outside sale or a withdrawal for this investment. The
   * strategy's share of what is missing comes off its claim first, so it
   * holds what the account actually holds; with `restore`, the cost of the
   * missing shares is then added and the plan buys them back, which it can
   * only do once the claim is right (a plan sizes from the claim, and a
   * paused investment is not planned at all).
   */
  const keepFollowing = async (restore: boolean): Promise<void> => {
    if (mine === null || actions === null || (!mine.outsideSale && !mine.outsideCash)) return;
    const sale = mine.outsideSale ?? null;
    const amount = restore && sale?.restoreAmount != null
      ? (Math.ceil(Number(sale.restoreAmount) * 100) / 100).toFixed(2)
      : null;
    setBusy('keep');
    setError(null);
    const result = await actions.strategyBuckets.resolveOutsideSale(mine.bucket.id, 'keep');
    if (!result.ok) {
      setBusy(null);
      setError(result.message);
      return;
    }
    if (amount !== null) {
      const bought = await actions.strategyBuckets.deposit(mine.bucket.id, amount);
      setBusy(null);
      setConfirmingRestore(false);
      setReload((key) => key + 1);
      onChanged?.();
      if (!bought.ok) {
        // The record is already right; only the buy-back did not happen.
        setError(`${bought.message} Your investment follows with what's left; add money any time to buy the ${sale?.symbol ?? 'holding'} back.`);
        return;
      }
      toast.add({
        title: `Buying back ${quantity(sale!.strategyShares ?? '0')} ${sale!.symbol}.`,
        description: 'The order shows under Activity as it fills.',
      });
      return;
    }
    setBusy(null);
    setReload((key) => key + 1);
    onChanged?.();
    toast.add({
      title: `Following ${mine.strategy.displayName} again.`,
      description: sale === null
        ? 'It follows with the cash that is left.'
        : hasShares(sale.strategyShares)
          ? `It follows with the shares that are left. Adding money later tops up ${sale.symbol} first.`
          : 'None of the sold shares were this investment\'s, so nothing changed.',
    });
  };

  // Orders held because the member confirms every trade, that no instruction
  // card covers (a rebalance, a new mix): the same release the queue's ✓ is.
  const confirmHeld = async (): Promise<void> => {
    if (mine === null || actions === null) return;
    setBusy('confirm');
    setError(null);
    const result = await actions.queue.act(`strategy:orders:${mine.bucket.id}:bucket`, 'confirm')
      .catch(() => ({ ok: false as const, status: 0, message: 'Could not reach Opentake. Check your connection.' }));
    setBusy(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    noteQueueActed();
    setReload((key) => key + 1);
  };

  const retry = async (): Promise<void> => {
    if (mine === null || actions === null) return;
    setBusy('retry');
    setError(null);
    const result = await actions.strategyBuckets.plan(mine.bucket.id);
    setBusy(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const plan = result.body as { disposition?: string; reasonCode?: string | null; delegated?: { placed: number; failed: number } | null } | null;
    const placed = plan?.delegated?.placed ?? 0;
    const failed = plan?.delegated?.failed ?? 0;
    toast.add({
      title: failed > 0
        ? 'An order failed again.'
        : placed > 0
          ? `Placed ${placed} ${placed === 1 ? 'order' : 'orders'}.`
          : plan?.disposition === 'up_to_date'
            ? 'Already at target.'
            : plan?.reasonCode && WAITING_TITLE[plan.reasonCode] !== undefined
              ? `${WAITING_TITLE[plan.reasonCode]}.`
              : 'Nothing to place right now.',
      description: failed > 0
        ? 'Check the Activity list below; the take tries again on its own.'
        : placed > 0 ? 'Fills show under Activity.' : plan?.reasonCode ? planReasonText(plan.reasonCode) : undefined,
    });
    setReload((key) => key + 1);
    onChanged?.();
  };

  if (holdings === null) return <div className="h-40 animate-pulse rounded-lg bg-muted" />;

  if (failedInvestment) return <FailedInvestment platform="Robinhood" accountName={failedInvestment.accountName} amount={failedInvestment.amount} currency={currency} assets={failedInvestment.assets} error={failedInvestment.message} busy={busy!==null} busyLabel="Retrying Robinhood investment…" onRetry={()=>void follow()} onDismiss={()=>{setFailedInvestment(null);setError(null);}}/>;

  if (mixedDeposit&&holdings!==null&&mine===null)return <><InvestmentSummary value="0" currency="USD" positions={[]} cash={[]}/><p className="text-xs text-muted-foreground">No Robinhood holdings in this Take.</p></>;
  if (mine !== null) {
    const value = mine.valuation.totalValue === null ? null : Number(mine.valuation.totalValue);
    const capital = mine.pnl ? Number(mine.pnl.capitalAllocated) : Number(mine.bucket.allocationValue ?? 'NaN');
    const returnPercent = mine.pnl?.allTimeReturn !== null && mine.pnl?.allTimeReturn !== undefined
      ? Number(mine.pnl.allTimeReturn)
      : value !== null && Number.isFinite(capital) && capital > 0 ? ((value - capital) / capital) * 100 : null;
    const gain = value !== null && Number.isFinite(capital) ? value - capital : null;
    const paused = mine.bucket.status === 'paused';
    // A paused or out-of-step investment shows the review card (resume or keep reduced) as the one thing to do.
    const reviewing = (paused || mine.bucket.status === 'diverged' || mine.requiresReconciliation === true) && !mine.closure;
    // An outside sale waiting on the member: adding or taking out money would
    // be sized against shares that are no longer there, so both wait.
    const awaitingDecision = Boolean(mine.outsideSale || mine.outsideCash) && mine.bucket.status === 'diverged';
    return (
      <div>
        <InvestmentSummary pendingBuys={instructions.filter(i=>['subscription','contribution'].includes(i.kind)&&['pending','open'].includes(i.status)).flatMap(i=>i.previewLegs.length?i.previewLegs.map(p=>({symbol:p.symbol,amount:p.notional,expectedAt:i.expectedAt??mine.ordersOpenAt??null})):(i.symbols.length?i.symbols:shares.length===0&&missingHoldings.length===1?missingHoldings:[]).map(symbol=>({symbol,amount:i.symbols.length<=1?i.requestedAmount:null,expectedAt:i.expectedAt??mine.ordersOpenAt??null})))} value={value===null?null:String(value)} currency={currency} gain={gain} returnPercent={returnPercent} positions={shares.map(position=>({symbol:position.symbol,quantity:quantity(position.quantity),price:position.markPrice,value:position.value,logo:<HoldingLogo weight={{symbol:position.symbol,logoUrl:logos.get(position.symbol)??null}}/>,name:<Link to="/rh/$symbol" params={{symbol:position.symbol}} className="inline-flex items-center gap-2 row-title hover:underline">{position.symbol}</Link>}))} cash={[{currency,value:String(mine.valuation.cash),quantity:String(mine.valuation.cash),reserved:instructionsLoadedFor!==bucketId||hasLiveInstruction||working?null:'0'}]}/>
        {/* Hosted asked an operator to check the brokerage; here the member does (owner decision 2026-10-05). */}
        {(mine.unknownOrders ?? []).map((order) => (
          <AlertCard
            key={order.legId}
            title={`${order.side === 'sell' ? 'Sell' : 'Buy'} ${order.symbol}: outcome unknown`}
            source={order.sentAt === null ? 'Sent to Robinhood' : `Sent to Robinhood ${new Date(order.sentAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`}
            rows={[{ label: 'Order', value: order.amount !== null ? money(order.amount, currency) : `${quantity(order.quantity ?? '0')} shares` }]}
            footnote="Robinhood has not confirmed whether this order was accepted. Opentake will match it automatically if it appears in your order history. Clear it only after checking Robinhood and confirming the order is not there."
            primary={{ label: busy !== null ? 'Saving…' : 'It is not in Robinhood', disabled: busy !== null || actions === null, onClick: () => {
              void window.allocations.abandonOrder(mine.bucket.id, order.legId).then((result) => {
                if (!result.ok) setError(result.message); else { setReload((value) => value + 1); onChanged?.(); }
              });
            } }}
          />
        ))}
        {!mixedDeposit&&!mine.closure && <RobinhoodVersionPanel allocationId={mine.bucket.id} onChanged={()=>{setReload(value=>value+1);onChanged?.();}}/>}
        {reviewing && (
          <AllocationReviewCard allocationId={mine.bucket.id} restoreRequired={mine.requiresReconciliation === true} currency={currency} onChanged={() => { setReload((value) => value + 1); onChanged?.(); }} onCloseTake={() => setClosing(true)} />
        )}
        {mine.outsideSale && !mine.closure && (
          <OutsideSaleCard
            sale={mine.outsideSale}
            currency={currency}
            busy={busy}
            confirming={confirmingRestore}
            available={buyingPower}
            onRestore={() => {
              if (!confirmingRestore) {
                setConfirmingRestore(true);
                return;
              }
              void keepFollowing(true);
            }}
            onContinue={() => void keepFollowing(false)}
            onUnfollow={() => setClosing(true)}
          />
        )}
        {mine.outsideCash && !mine.closure && (
          <CashMissingCard
            cash={mine.outsideCash}
            currency={currency}
            busy={busy}
            waiting={waitingForTransfer}
            onRestore={() => setWaitingForTransfer(true)}
            onUnfollow={() => setClosing(true)}
          />
        )}
        {mine.ordersOpenAt && !mine.closure && !instructions.some((instruction) => instruction.kind !== 'partial_redemption') && (
          <Notice
            tone="scheduled"
            title={missingHoldings.length > 0
              ? `Buying ${listSymbols(missingHoldings)} at ${timeLabel(mine.ordersOpenAt)}`
              : `Orders go out at ${timeLabel(mine.ordersOpenAt)}`}
            text="Market's closed. Your money waits as cash until the open."
          />
        )}
        {instructions
          .filter((instruction) => !mine.closure || instruction.kind === 'full_exit')
          .map((instruction) => (
            <InstructionCard
              key={instruction.id}
              instruction={instruction}
              currency={currency}
              busy={busy === 'instruction'}
              onCancel={() => void answerInstruction(instruction, 'cancel')}
              onConfirm={() => void answerInstruction(instruction, 'confirm')}
            />
          ))}
        {mine.waiting && !mine.ordersOpenAt && !mine.closure &&
          !instructions.some((instruction) =>
            (instruction.status === 'pending' && instruction.pendingReason === mine.waiting?.reason) ||
            instruction.waitingFor === mine.waiting?.reason) && (
          mine.waiting.reason === 'awaiting_confirmation' ? (
            <Notice
              tone="scheduled"
              title="Orders waiting for your OK"
              text="You asked to confirm every trade. Nothing is placed until you confirm."
              action={{ label: busy === 'confirm' ? 'Confirming…' : 'Confirm', onClick: () => void confirmHeld(), disabled: busy !== null }}
            />
          ) : mine.waiting.reason === 'retry_backoff' ? (
            <Notice
              tone="retry"
              title={mine.waiting.until ? `Retrying at ${timeLabel(mine.waiting.until)}` : 'Retrying shortly'}
              text="Last orders didn't go through. Each retry waits a bit longer."
              action={{ label: busy === 'retry' ? 'Retrying…' : 'Retry now', onClick: () => void retry(), disabled: busy !== null || working }}
            />
          ) : (
            <Notice
              tone="scheduled"
              title={WAITING_TITLE[mine.waiting.reason] ?? 'Waiting'}
              text={`${planReasonText(mine.waiting.reason)}${mine.waiting.until && mine.waiting.reason !== 'lots_unsettled' ? ` It looks again at ${timeLabel(mine.waiting.until)}.` : ''}`}
            />
          )
        )}
        {instructionsLoadedFor===bucketId && !hasLiveInstruction && !working && (mine.lastFailure || missingHoldings.length > 0) && !mine.closure && !mine.ordersOpenAt && !mine.waiting && (
          <Notice
            tone="error"
            title={untradableMissing.length > 0
              ? `${listSymbols(untradableMissing)} can't be traded right now`
              : mine.lastFailure
                ? `${mine.lastFailure.symbol ?? 'An'} order failed`
                : `${listSymbols(missingHoldings)} ${missingHoldings.length === 1 ? 'is' : 'are'} not held yet`}
            text={untradableMissing.length > 0
              ? 'Robinhood won’t trade it now. That part of your money is held as cash until the take can buy.'
              : `That part of your money is held as cash, not following the take, until it buys.${mine.lastFailure ? ` ${failureLabel(mine.lastFailure.code).replace(/^./, (letter) => letter.toUpperCase())}.` : ''}`}
            action={{ label: busy === 'retry' ? 'Retrying…' : 'Retry', onClick: () => void retry(), disabled: busy !== null || working }}
          />
        )}
        {mine.closure && closureNeedsDecision(mine.closure.status) ? (
          mine.closure.status === 'failed' || mine.closure.reason === 'close' ? (
            <AlertCard
              title="The close did not go through"
              source={closureFailureText(mine.closure.failureCode ?? null)}
              rows={[{ label: 'To sell', value: mine.closure.sellSymbols !== null && mine.closure.sellSymbols.length > 0 ? listSymbols(mine.closure.sellSymbols) : 'Nothing' }]}
              footnote="Nothing trades until you decide. Retry the same sells, or choose again: anything you don't sell stays in your account as your own shares."
              primary={{ label: busy === 'close' ? 'Retrying…' : 'Retry', disabled: busy !== null || actions === null, onClick: () => void closeInvestment(mine.closure?.sellSymbols ?? 'all') }}
              secondary={{ label: 'Choose again', disabled: busy !== null || actions === null, onClick: () => setClosing(true) }}
            />
          ) : (
            <AlertCard
              title="You archived this take"
              source={mine.closure.openedAt ? `Archived ${sinceLabel(mine.closure.openedAt) ?? ''}` : 'Archived'}
              rows={[{ label: 'Positions', value: String(shares.length) }]}
              footnote="Nothing trades until you decide. Keep the shares in your account as your own, or sell them and keep the cash. Unarchive the take to keep following it."
              primary={{ label: 'Choose what to sell', disabled: busy !== null || actions === null, onClick: () => setClosing(true) }}
              secondary={{ label: busy === 'close' ? 'Keeping…' : 'Keep all shares', disabled: busy !== null || actions === null, onClick: () => void closeInvestment('none') }}
            />
          )
        ) : mine.closure ? (
          instructions.some((instruction) => instruction.kind === 'full_exit') ? null : (
          <p className="mt-3 text-xs text-pretty text-muted-foreground">
            {mine.closure.status === 'selling'
              ? 'Closing: the chosen positions are being sold; the rest become your own shares once the orders fill.'
              : mine.closure.status === 'held'
                ? 'Closed. You kept the shares; they are now yours to manage.'
                : 'Closed. The chosen positions were sold; anything held is now yours.'}
          </p>
          )
        ) : (
          <>
            {/* An outside sale or a withdrawal waiting on the member: the card
                above is the only thing to do, so adding and taking out money
                are not shown at all rather than shown and refused. The same
                holds while the investment waits to be reviewed and resumed. */}
            <InvestmentControls accounts={takeId&&!mixedDeposit?<TakeAccountPlan takeId={takeId} showInvestment={false}/>:undefined}
              deposit={!mixedDeposit&&instructionsLoadedFor===bucketId&&!hasLiveInstruction&&!working&&!awaitingDecision&&!reviewing?{onClick:()=>setDepositOpen(true),disabled:busy!==null||paused||working||actions===null}:undefined}
              withdraw={!mixedDeposit&&instructionsLoadedFor===bucketId&&!hasLiveInstruction&&!working&&!awaitingDecision&&!reviewing?{onClick:()=>setChoosing(true),disabled:busy!==null||working||actions===null}:undefined}/>
            <TakeMoneyOutMenu cashOnly={!mine.positions.some(p=>Number(p.quantity)>0)} open={choosing} title={mine.strategy.displayName} busy={busy!==null} canReduce={canReduce!==false}
              onOpenChange={setChoosing} onReduce={()=>setReducing(true)} onClosePositions={()=>setClosing(true)}/>
            <ReducePositionsDialog
              accountName={account?.maskedNumber||'your Robinhood account'}
              open={reducing}
              onOpenChange={setReducing}
              bucketId={mine.bucket.id}
              currency={currency}
              busy={busy === 'reduce'}
              onConfirm={reduce}
            />
            <Dialog open={depositOpen} onOpenChange={(next) => { if (!next && busy !== 'deposit') { setDepositOpen(false); setRestoring(null); } }}>
              <DialogContent className="max-w-sm">
                <DialogHeader>
                  <DialogTitle>
                    {restoring !== null ? `Buy back ${quantity(restoring.shares)} ${restoring.symbol}` : 'Deposit'}
                  </DialogTitle>
                  <DialogDescription>
                    {restoring !== null
                      ? `You're following ${mine.strategy.displayName} again. This amount buys back the ${restoring.symbol} that was sold; nothing else is bought or sold. Cancel to follow with what's left.`
                      : 'The cash buys this take\'s holdings at their current weights, so your mix does not change. Nothing is sold.'}
                  </DialogDescription>
                </DialogHeader>
                <InvestmentAmountForm
                  title={null}
                  actionLabel={restoring !== null ? 'Buy back' : 'Deposit'}
                  amountLabel="Amount to deposit in dollars"
                  amount={depositAmount}
                  onAmountChange={setDepositAmount}
                  maxAmount={buyingPower}
                  funding={{accountName:account?.maskedNumber||'Account',platform:'Robinhood',currency}}
                  inputDisabled={busy === 'deposit'}
                  disabled={busy === 'deposit' || depositPreflight?.ok === false || actions === null}
                  busyLabel={busy === 'deposit' ? 'Depositing via Robinhood…' : undefined}
                  onInvest={()=>void deposit()}
                  minimum={depositMinimum !== null ? `Minimum ${money(depositMinimum)}` : undefined}
                  summary={<PreflightSummary preflight={depositPreflight} currency={currency} minimumShown={depositMinimum !== null} />}
                />
                {depositOpen && error !== null && <p className="text-xs text-error">{error}</p>}
                <Button size="sm" variant="ghost" onClick={() => { setDepositOpen(false); setRestoring(null); }} disabled={busy === 'deposit'}>Cancel</Button>
              </DialogContent>
            </Dialog>
          </>
        )}
        <ClosePositionsDialog
          holding={mine}
          open={closing}
          title={mixedDeposit?"Close Robinhood holdings":"Close this take"}
          accountName={account?.maskedNumber||'your Robinhood account'}
          description={`Tick what to sell. Anything left unticked stays in ${account?.maskedNumber||'your Robinhood account'} as your own holding.`}
          busy={busy === 'close'}
          error={closing ? error : null}
          onClose={() => setClosing(false)}
          onConfirm={(sell) => void closeInvestment(sell)}
        />
        {error !== null && !closing && !depositOpen && <p className="mt-2 text-xs text-error">{error}</p>}
        {!mixedDeposit&&<StrategyActivityPanel strategyId={strategyId} reloadKey={reload} currency={currency} />}
      </div>
    );
  }

  // A draft has nothing to invest in yet; the author row above the page says so.
  if (!published) return <></>;

  return (
    <div>
      <InvestmentAmountForm maxAmount={buyingPower} funding={{accountName:account?.maskedNumber||'Account',platform:'Robinhood',currency,buyingPower:buyingPower===null?[]:[{asset:currency,amount:buyingPower}]}} inputDisabled={busy !== null} amount={amount} onAmountChange={setAmount} onInvest={()=>void follow()}
        disabled={busy !== null || account === null || investPreflight?.ok === false || actions === null}
        busyLabel={busy === 'follow' ? 'Investing via Robinhood…' : undefined}
        minimum={minimumAllocation !== null ? `Minimum ${money(minimumAllocation)}` : undefined}
        summary={<PreflightSummary preflight={investPreflight} currency={currency} minimumShown={minimumAllocation !== null} />}
        footnote="Money stays in your Robinhood account. Opentake buys the holdings there and keeps them on target. You can close the investment at any time." />
      {error !== null && <p className="mt-2 text-xs text-error">{error}</p>}
      {!mixedDeposit&&<StrategyActivityPanel strategyId={strategyId} reloadKey={reload} currency={currency} />}
    </div>
  );
}

/** Why a plan was deferred, in the member's words; falls back to the code. */
/**
 * What the planner is waiting on, in the member's terms. Every one of these
 * is a reason that asks nothing of them; the sentence says what is being
 * waited for and that it resolves on its own, because "Reason: lots_unsettled"
 * read as an error to the first person who saw it.
 */
function planReasonText(code: string): string {
  switch (code) {
    case 'lots_unsettled':
      return 'Shares bought today cannot be sold until they settle. The sell goes out at the next market open; nothing for you to do.';
    case 'market_closed':
      return 'The market is closed. The orders go out when it opens.';
    case 'retry_backoff':
      return 'An order was refused, so the take is waiting a little before trying again.';
    case 'correction_not_improving':
      return 'Prices have changed, but a trade would not bring your holdings closer to the target mix right now. Opentake will check again automatically.';
    case 'model_stale':
      return "Waiting for an updated portfolio valuation after the last market close. Opentake will try again automatically.";
    case 'fresh_position_snapshot_required':
      return 'Your positions have not synced recently; it tries again in a few minutes.';
    case 'incomplete_basket':
      return 'The amount allocated to one holding is too small to buy. The first purchase is paused until the full basket can be bought.';
    case 'insufficient_buying_power':
      return 'Your Robinhood account needs more available cash for the next purchase. The order will be submitted when enough cash is available.';
    case 'symbol_not_tradable':
      return 'Robinhood is not trading one of the holdings right now. The take waits until it does.';
    case 'daily_notional_limit':
      return "Today's trading limit for this investment has been reached. It continues tomorrow.";
    case 'awaiting_confirmation':
      return 'You asked to confirm every trade. Its orders wait in your queue until you confirm them.';
    case 'symbol_blocked':
      return 'This take holds a market you blocked in Settings, so nothing is bought until you unblock it or stop following.';
    case 'attributed_lots_unavailable':
      return 'Opentake is still confirming which shares belong to this Take. It will try again after the next sync.';
    case 'negative_subledger_balance':
      return 'This Take spent more than its recorded balance. Use the card above to cover the difference or close the investment.';
    default:
      return `Reason: ${code}.`;
  }
}

const WAITING_TITLE: Record<string, string> = {
  lots_unsettled: 'Waiting for shares to settle',
  market_closed: 'Waiting for the market to open',
  retry_backoff: 'Trying again shortly',
  correction_not_improving: 'Nothing worth trading right now',
  model_stale: "Waiting for tonight's valuation",
  fresh_position_snapshot_required: 'Waiting for your positions to sync',
  incomplete_basket: 'Waiting to buy the whole basket',
  insufficient_buying_power: 'Waiting for cash',
  symbol_not_tradable: 'Waiting on Robinhood',
  daily_notional_limit: 'Done trading for today',
  awaiting_confirmation: 'Waiting for your confirmation',
  symbol_blocked: 'Holds a market you blocked',
  attributed_lots_unavailable: 'Waiting for the next sync',
  negative_subledger_balance: 'Needs your review',
};

function hasShares(value: string | null): boolean {
  return value !== null && Number(value) > 0;
}

function saleSource(iso: string | null): string {
  return iso === null
    ? 'Robinhood'
    : `Robinhood · ${new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

/**
 * Shares this investment held were sold outside Earlybird. The card is the
 * sale as Robinhood reported it, what was the member's own, what this
 * strategy lost, and what continuing the strategy costs. Either they restore
 * it -- the missing shares come off the claim and are bought back with their
 * Robinhood cash -- or they stop following. There is no third option that
 * keeps following while holding something else.
 */
function OutsideSaleCard({ sale, currency, busy, confirming, available, onRestore, onContinue, onUnfollow }: {
  sale: NonNullable<HoldingWithPnl['outsideSale']>;
  currency: string;
  busy: string | null;
  confirming: boolean;
  /** Cash the member could spend, after what their strategies hold; null when unknown. */
  available: string | null;
  onRestore: () => void;
  onContinue: () => void;
  onUnfollow: () => void;
}): React.JSX.Element {
  const missing = sale.strategyShares ?? '0';
  const restore = sale.restoreAmount === null
    ? null
    : (Math.ceil(Number(sale.restoreAmount) * 100) / 100).toFixed(2);
  // Under the provider's smallest order there is nothing to buy back, so the
  // member is not asked to choose; the server settles those before they show.
  const restorable = restore !== null && Number(restore) >= MINIMUM_ORDER_USD;
  // Buying the shares back spends the member's own cash. When there is not
  // enough of it, the button says what has to happen first rather than
  // offering an action the broker would refuse.
  const short = restorable && available !== null && Number(available) < Number(restore);
  const rows: AlertRow[] = [];
  if (sale.soldQuantity !== null) {
    rows.push({
      label: 'Sold on Robinhood',
      value: `${quantity(sale.soldQuantity)} ${sale.symbol}${sale.proceeds === null ? '' : ` · +${money(sale.proceeds, currency)}`}`,
    });
  }
  if (sale.ownShares !== null) rows.push({ label: 'From your own shares', value: quantity(sale.ownShares) });
  rows.push({ label: 'From this take', value: quantity(missing), accent: true });
  return (
    <AlertCard
      title={`${sale.symbol} sold outside Earlybird`}
      source={saleSource(sale.soldAt)}
      value={`−${quantity(missing)}`}
      rows={rows}
      footnote={short
        ? `${money(available ?? '0', currency)} of your Robinhood cash is free. Add ${money(String(Math.max(0, Number(restore) - Number(available ?? 0)).toFixed(2)), currency)} to restore this.`
        : !restorable
          ? 'What is missing is too small to buy back.'
          : confirming
            ? `Buys ${quantity(missing)} ${sale.symbol} back with your Robinhood cash.`
            : `Restoring buys ${quantity(missing)} ${sale.symbol} back so this follows the take again.`}
      primary={{
        label: busy === 'keep'
          ? 'Working…'
          : short
            ? 'Add funds'
            : !restorable ? 'Continue take' : `${confirming ? 'Confirm' : 'Restore'} · ${money(restore!, currency)}`,
        onClick: restorable ? onRestore : onContinue,
        disabled: busy !== null || short,
      }}
      secondary={{ label: 'Unfollow', onClick: onUnfollow, disabled: busy !== null }}
    />
  );
}

/**
 * Cash this investment held is no longer in the account. Its holdings are
 * untouched, so the strategy is still being followed; what is missing is the
 * money it had to invest. Only a transfer back into Robinhood restores it,
 * which Earlybird cannot do, so the card says the amount and the check that
 * resumes the investment runs on its own.
 */
function CashMissingCard({ cash, currency, busy, waiting, onRestore, onUnfollow }: {
  cash: NonNullable<HoldingWithPnl['outsideCash']>;
  currency: string;
  busy: string | null;
  waiting: boolean;
  onRestore: () => void;
  onUnfollow: () => void;
}): React.JSX.Element {
  const amount = cash.strategyAmount === null
    ? null
    : (Math.ceil(Number(cash.strategyAmount) * 100) / 100).toFixed(2);
  const rows: AlertRow[] = [{ label: 'Takes were holding', value: money(cash.strategiesCash, currency) }];
  if (cash.accountCash !== null) rows.push({ label: 'Robinhood cash now', value: money(cash.accountCash, currency) });
  if (amount !== null) rows.push({ label: 'Short for this take', value: money(amount, currency), accent: true });
  return (
    <AlertCard
      title="Take cash is missing"
      source="Robinhood · withdrawn or spent"
      value={amount === null ? null : `−${money(amount, currency)}`}
      rows={rows}
      footnote={amount === null
        ? 'This resumes on its own once the cash is back.'
        : `Add ${money(amount, currency)} back to Robinhood and this resumes on its own.`}
      primary={{
        label: waiting ? 'Waiting for the transfer' : amount === null ? 'Restore' : `Restore · ${money(amount, currency)}`,
        onClick: onRestore,
        disabled: busy !== null || waiting,
      }}
      secondary={{ label: 'Unfollow', onClick: onUnfollow, disabled: busy !== null }}
    />
  );
}
