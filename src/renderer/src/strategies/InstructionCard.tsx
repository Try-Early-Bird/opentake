import type {InstructionOrder} from '../../../shared/instruction-order';
import { assetAmount, money } from '../portfolio/format';

import { ScheduledCard, type ScheduledStep } from '../components/ScheduledCard';
import { whenHeading } from '../when-label';

// A member instruction that is recorded and has not finished -- a withdrawal, a deposit, a first investment, or
// a close waiting to sell -- mapped onto the scheduled card: its title, the
// amount, a short timeline of what happens next, and what can still be done.

export interface StrategyInstruction {
  accountLabel?: string;
  venue?: string;
  id: string;
  kind: string;
  requestedAmount: string | null;
  status: 'pending' | 'open' | 'settled' | 'failed' | 'cancelled' | 'superseded';
  pendingReason: string | null;
  waitingFor: string | null;
  symbols: string[];
  expectedAt: string | null;
  cancellable: boolean;
  orders?:InstructionOrder[];
  previewLegs: { symbol: string; notional: string }[];
}

type Step = ScheduledStep;

const NOUN: Record<string, string> = {
  partial_redemption: 'Withdrawal',
  contribution: 'Deposit',
  subscription: 'Investment',
  full_exit: 'Close',
  rebalance: 'Rebalance',
};

function listSymbols(symbols: readonly string[]): string {
  if (symbols.length <= 1) return symbols.join('');
  return `${symbols.slice(0, -1).join(', ')} and ${symbols[symbols.length - 1]}`;
}

function plan(instruction: StrategyInstruction, amount: string): { state: string; steps: Step[]; footer: string } {
  const selling = instruction.kind === 'partial_redemption' || instruction.kind === 'full_exit';
  const when = instruction.expectedAt ? whenHeading(instruction.expectedAt) : 'Next';
  const outcome = instruction.kind === 'rebalance' ? 'We trade toward this Take’s target weights' : instruction.kind === 'full_exit'
    ? instruction.symbols.length > 0 ? `We sell ${listSymbols(instruction.symbols)} automatically` : 'We sell your chosen holdings automatically'
    : selling
    ? `We sell ${amount} automatically`
    : instruction.symbols.length > 0
      ? `We buy ${listSymbols(instruction.symbols)} with ${amount} automatically`
      : `We invest ${amount} automatically`;

  if (['settled','failed','cancelled'].includes(instruction.status)) {
    const partial=instruction.pendingReason==='partial_completion';
    return {state:partial?'Partially completed':instruction.status==='settled'?'Completed':instruction.status==='failed'?'Failed':'Cancelled',
      steps:[{heading:'Now',text:partial?(['subscription','contribution','rebalance'].includes(instruction.kind)?'Some orders did not fill. Holdings and unused cash remain in this Take.':'Some orders did not fill. Unsold holdings remain in this Take.'):instruction.status==='settled'?(instruction.kind==='full_exit'&&instruction.symbols.length===0?'The Take is closed. Your holdings and cash remain in your account.':'All orders have filled and reconciled.'):instruction.status==='failed'?'The orders did not complete. Check the order details.':'No further orders will be placed.',upcoming:false}],footer:''};
  }
  if (['orders_pending','cancellation_pending','reconciliation_required'].includes(instruction.waitingFor??'')) {
    return {state:instruction.waitingFor==='cancellation_pending'?'Cancellation pending':instruction.waitingFor==='reconciliation_required'?'Status unresolved':instruction.kind==='rebalance'?'Trading':selling?'Selling':'Buying',
      steps:[{heading:'Now',text:instruction.waitingFor==='cancellation_pending'?'Waiting for the remaining orders to be cancelled.':instruction.waitingFor==='reconciliation_required'?'Checking the outcome of submitted orders.':'Orders submitted. Waiting for completed trades to sync.',upcoming:false}],footer:'Funds for unresolved orders remain reserved.'};
  }
  if (instruction.waitingFor === 'retry_required') {
    return {state: 'Didn’t start', steps: [{heading: 'Now', text: 'No orders were submitted. Retry to review updated amounts.', upcoming: false}], footer: ''};
  }
  if (instruction.pendingReason === 'reconfirm_required') {
    return {
      state: 'Needs your OK',
      steps: [
        { heading: 'Now', text: `Prices moved it onto different holdings than ${instruction.previewLegs.map((leg) => leg.symbol).join(', ')}`, upcoming: false },
        { heading: 'When you confirm', text: `We sell ${amount} from what you hold now`, upcoming: true },
      ],
      footer: 'Confirm to go ahead, or cancel',
    };
  }
  if (instruction.waitingFor === 'awaiting_confirmation') {
    return {
      state: 'Needs your OK',
      steps: [
        { heading: 'Now', text: 'You asked to confirm every trade', upcoming: false },
        { heading: 'When you confirm', text: outcome.replace(/ automatically$/u, ''), upcoming: true },
      ],
      footer: '',
    };
  }
  if (instruction.waitingFor === 'requested') {
    return {state: 'Pending', steps: [{heading: 'Now', text: 'Orders have not been submitted yet.', upcoming: false}], footer: ''};
  }
  if (instruction.waitingFor !== null) {
    const now: Step = instruction.waitingFor === 'lots_unsettled'
      ? { heading: 'Today', text: "Today's share purchases finish settling", upcoming: false }
      : instruction.waitingFor === 'market_closed'
        ? { heading: 'Now', text: 'The market is closed', upcoming: false }
        : instruction.waitingFor === 'requested'
          ? { heading: 'Now', text: 'Working out the orders', upcoming: false }
          : { heading: 'Now', text: 'Waiting for your account to be ready', upcoming: false };
    return {
      state: 'Scheduled',
      steps: [now, { heading: when, text: outcome, upcoming: true }],
      footer: instruction.kind === 'full_exit'
        ? 'Nothing for you to do; it sells by itself'
        : instruction.cancellable ? '' : 'It can no longer be cancelled',
    };
  }
  if (instruction.cancellable) {
    return {
      state: 'Queued',
      steps: [
        { heading: 'Now', text: selling ? 'The sell orders are queued' : 'The buy orders are queued', upcoming: false },
        { heading: 'Next', text: 'They go out at the next chance', upcoming: true },
      ],
      footer: 'Cancel anytime before they go out',
    };
  }
  return {
    state: selling ? 'Selling' : 'Buying',
    steps: [{ heading: 'Now', text: selling ? `Selling ${amount}` : `Buying with ${amount}`, upcoming: false }],
    footer: 'The orders have been sent and can no longer be cancelled',
  };
}

function orderStep(order:InstructionOrder):Step{
 const state=order.execution.state,filled=order.filledQuantity!==undefined&&Number(order.filledQuantity)>0;
 const cancelling=['requested','sending','unknown'].includes(order.execution.cancelState);
 const label=state==='filled'?'Filled':state==='cancelled'?'Cancelled':state==='rejected'?'Rejected':state==='expired'?'Expired':cancelling?'Cancellation pending':state==='partially_filled'?'Partially filled':state==='accepted'?'Open':state==='submitting'?'Submitting':state==='unknown'||state==='reconciliation_required'?'Status unresolved':'Not submitted';
 const fill=filled?`${assetAmount(order.filledQuantity!,order.symbol)} ${order.side==='buy'?'bought':'sold'}.`:'';
 const terminal=['filled','cancelled','rejected','expired'].includes(state);
 const detail=terminal?state==='filled'?(fill||'Order filled.'):`${fill}${fill?' ':''}${order.filledQuantity==='0'?'Nothing filled.':filled?'Remaining quantity did not fill.':'Order did not complete.'}`:cancelling?`${fill}${fill?' ':''}Waiting for cancellation confirmation.`:state==='accepted'||state==='partially_filled'?`${fill}${fill?' ':''}Waiting for ${filled?'the remaining quantity':'a fill'}.`:state==='unknown'||state==='reconciliation_required'?'Checking the order outcome.':'Waiting to submit.';
 const decimal=(value:string)=>Number(value).toLocaleString('en-US',{maximumFractionDigits:8});
 const quote=order.currency??'';
 const estimate=state==='filled'&&filled?'':order.quantity!==undefined?`Amount: ${decimal(order.quantity)} ${order.symbol}`:order.estimatedValue!==undefined?`Estimated amount: ${decimal(order.estimatedValue)} ${quote}`:'';
 const total=order.estimatedValue!==undefined&&order.estimatedFee!==undefined
  ?`Estimated ${order.side==='buy'?'total cost':'net proceeds'}: ${decimal(String(Number(order.estimatedValue)+(order.side==='buy'?1:-1)*Number(order.estimatedFee)))} ${quote}`:'';
 const planned=[estimate,total].filter(Boolean).join(' · ');
 const specific=order.orderType?`${order.symbol} ${order.orderType} ${order.side}`:`${order.symbol} ${order.side}`;
 return {heading:`${specific} · ${label}`,text:[detail,planned].filter(Boolean).join(' '),upcoming:!terminal};
}

export function InstructionCard({ children, instruction, currency, busy, onCancel, onConfirm, onRefresh, onRetry, platform = 'Robinhood' }: {
  children?: React.ReactNode;
  instruction: StrategyInstruction;
  currency: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onRefresh?: () => void;
  onRetry?: () => void;
  platform?: 'Coinbase'|'Robinhood';
}): React.JSX.Element {
  const amount = money(instruction.requestedAmount ?? '0', currency);
  const { state, steps, footer } = plan(instruction, amount);
  const changed = instruction.pendingReason === 'reconfirm_required' || instruction.waitingFor === 'awaiting_confirmation';
  const orderSteps=(instruction.orders??[]).map(orderStep);
  const detailed=instruction.orders?.some(order=>order.estimatedValue!==undefined);
  const submitted=instruction.orders?.filter(order=>['accepted','partially_filled','filled'].includes(order.execution.state)).length??0;
  const filled=instruction.orders?.filter(order=>order.execution.state==='filled').length??0;
  const mappedSteps=steps.map((step,index)=>index===0?{...step,heading:state, text:detailed&&instruction.waitingFor==='orders_pending'?`${submitted} of ${instruction.orders!.length} orders accepted by ${instruction.venue??platform}. ${filled} filled. See each order below.`:step.text}:step);
  return (
    <ScheduledCard
      children={children}
      subtitle={instruction.accountLabel?`${instruction.venue??platform} · ${instruction.accountLabel}`:undefined}
      title={NOUN[instruction.kind] ?? 'Order'}
      amount={instruction.requestedAmount !== null ? amount : null}
      steps={[...mappedSteps,...orderSteps]}
      footer={['subscription','contribution'].includes(instruction.kind)&&['open','pending'].includes(instruction.status)&&!['orders_pending','cancellation_pending','reconciliation_required'].includes(instruction.waitingFor??'')?(instruction.cancellable?`Cancelling stops these orders. Unused cash stays in the Take.`:'Cash for pending orders stays reserved until their outcome is known.'):footer}
      busy={busy}
      onRefresh={onRefresh}
      {...(onRetry&&(instruction.waitingFor==='retry_required'||(['subscription','contribution'].includes(instruction.kind)&&['settled','failed','cancelled'].includes(instruction.status)))?{onConfirm:onRetry,confirmLabel:instruction.kind==='partial_redemption'?'Retry withdrawal':'Retry investment'}:changed ? { onConfirm } : {})}
      {...(instruction.cancellable || changed ? { onCancel } : {})}
    />
  );
}
