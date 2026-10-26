import { z } from 'zod';
import { basketSchema, instrumentKey, assertInstrumentExecution } from '../../shared/strategies';
import { amount, fingerprint, format } from '../allocations/ledger';
import { conserveRequestedNotionals, sizeTargetAllocation, type TargetSizingDecision } from './target-sizing';

const decimal = z.string().regex(/^(0|[1-9][0-9]{0,19})(\.[0-9]{1,18})?$/);
const positive = decimal.refine(value => amount(value) > 0n, 'Positive amount required');
export const previewRequestSchema = z.object({
  accountId: z.uuid(), strategyId: z.uuid(), versionId: z.uuid(),
  amount: positive.refine(value => amount(value) % (10n ** 16n) === 0n, 'Use whole cents'),
}).strict();
export type PreviewRequest = z.infer<typeof previewRequestSchema>;
const evidenceSchema = z.object({
  accountId: z.uuid(), venue: z.string(), observedAt: z.iso.datetime(),
  instruments: z.array(z.object({
    symbol: z.string(), instrumentRef: z.string().min(1),
    markPriceUsd: positive.nullable(), tradable: z.boolean().nullable(), fractional: z.boolean().nullable(),
  }).strict()).max(50),
}).strict();
export type PreviewEvidence = z.infer<typeof evidenceSchema>;
export interface VenueSizingRules {
  venue: string; minimumOrderNotionalUsd: string; maximumOrderNotionalUsd: string;
  sellMinimumHeadroomBps: number; evidenceMaxAgeMs: number;
}
/** The caller chooses its order limit; this is not a claimed provider maximum. */
export const robinhoodPreviewRules = (maximumOrderNotionalUsd: string): VenueSizingRules => ({
  venue: 'robinhood', minimumOrderNotionalUsd: '1', maximumOrderNotionalUsd,
  sellMinimumHeadroomBps: 500, evidenceMaxAgeMs: 60_000,
});
type Reason = 'unsupported_venue' | 'missing_instrument_evidence' | 'missing_mark_price' |
  'symbol_not_tradable' | 'unknown_tradability' | 'whole_share_sizing_unavailable' |
  'unknown_fractional_sizing' | 'order_notional_limit';
export interface PreviewSleeve {
  venue: string; symbol: string; instrumentRef: string | null; targetBps: number;
  markPriceUsd: string | null; disposition: 'order' | 'skip' | 'defer';
  reason: Reason | Extract<TargetSizingDecision, {disposition:'skip'|'defer'}>['reason'] | null;
  dollarAmount: string | null;
}
/** Hypothetical cash-only allocation. No account holdings, writes, or execution authority. */
export function planFirstInvestment(input: {
  request: PreviewRequest; spec: unknown; evidence: PreviewEvidence;
  availableCashUsd: string; now: string; rules: VenueSizingRules;
}) {
  const request = previewRequestSchema.parse(input.request);
  const spec = basketSchema.parse(input.spec);
  const evidence = evidenceSchema.parse(input.evidence);
  const available = amount(input.availableCashUsd), capital = amount(request.amount);
  const now = z.iso.datetime().parse(input.now), rules = input.rules;
  positive.parse(rules.minimumOrderNotionalUsd); positive.parse(rules.maximumOrderNotionalUsd);
  if (!Number.isSafeInteger(rules.evidenceMaxAgeMs) || rules.evidenceMaxAgeMs <= 0) throw new Error('Invalid evidence freshness policy');
  if (evidence.accountId !== request.accountId || evidence.venue !== rules.venue) throw new Error('Evidence account or venue mismatch');
  const age = Date.parse(now) - Date.parse(evidence.observedAt);
  if (age < 0 || age > rules.evidenceMaxAgeMs) throw new Error('Fresh instrument evidence required');
  const bySymbol = new Map(evidence.instruments.map(row => [row.symbol, row]));
  if (bySymbol.size !== evidence.instruments.length || new Set(evidence.instruments.map(row => row.instrumentRef)).size !== evidence.instruments.length) throw new Error('Duplicate instrument evidence');
  assertInstrumentExecution(spec);
  const weights = [...spec.target.weights].sort((a,b) => instrumentKey(a.instrument).localeCompare(instrumentKey(b.instrument)));
  let remaining = capital;
  const sleeves: PreviewSleeve[] = weights.map(({instrument,bps}) => {
    const facts = instrument.venue === rules.venue ? bySymbol.get(instrument.symbol) : undefined;
    const row: PreviewSleeve = {...instrument, instrumentRef:facts?.instrumentRef ?? null, targetBps:bps,
      markPriceUsd:facts?.markPriceUsd ?? null, disposition:'defer', reason:null, dollarAmount:null};
    const reason: Reason | null = instrument.venue !== rules.venue ? 'unsupported_venue' : !facts ? 'missing_instrument_evidence' :
      facts.tradable === false ? 'symbol_not_tradable' : facts.tradable === null ? 'unknown_tradability' :
      facts.fractional === false ? 'whole_share_sizing_unavailable' : facts.fractional === null ? 'unknown_fractional_sizing' :
      facts.markPriceUsd === null ? 'missing_mark_price' : null;
    if (reason) return {...row, reason};
    const sized = sizeTargetAllocation({symbol:instrument.symbol,targetWeightPercent:bps/100,
      allocationValueUsd:request.amount,currentInstrumentValueUsd:'0',currentQuantity:'0',
      availableCashUsd:format(remaining),markPriceUsd:facts!.markPriceUsd,
      maximumOrderNotionalUsd:rules.maximumOrderNotionalUsd,minimumOrderNotionalUsd:rules.minimumOrderNotionalUsd,
      sellMinimumHeadroomBps:rules.sellMinimumHeadroomBps,rebalanceThresholdBps:0});
    if (sized.disposition !== 'order') return {...row,disposition:sized.disposition,reason:sized.reason};
    if (sized.order.side !== 'buy') throw new Error('First investment may only buy');
    remaining -= amount(sized.order.dollarAmount);
    return {...row,disposition:'order',dollarAmount:sized.order.dollarAmount};
  });
  // Only return cents lost by orders that actually fit. A skipped holding's
  // allocation stays cash; personal strategies do not promise full replication.
  const orders = sleeves.filter(row => row.disposition === 'order');
  const intended = orders.reduce((sum,row) => sum + capital * BigInt(row.targetBps) / 10000n, 0n);
  const conserved = new Map(conserveRequestedNotionals(orders.map(row => ({symbol:row.symbol,dollarAmount:row.dollarAmount!})),format(intended),request.amount)
    .map(row => [row.symbol,row.dollarAmount]));
  for (const row of orders) {
    row.dollarAmount = conserved.get(row.symbol)!;
    if (amount(row.dollarAmount) > amount(rules.maximumOrderNotionalUsd)) {
      row.disposition = 'defer'; row.reason = 'order_notional_limit'; row.dollarAmount = null;
    }
  }
  const total = sleeves.reduce((sum,row) => sum + amount(row.dollarAmount ?? '0'),0n);
  const deferred = sleeves.some(row => row.disposition === 'defer');
  const plan = {schemaVersion:1 as const, kind:'first_investment' as const, ...request,
    amount:format(capital),asOf:now,targetBasis:'committed' as const,availableCashUsd:format(available),canFund:capital<=available,
    disposition:capital>available || deferred ? 'deferred' as const : total===0n ? 'no_orders' as const : 'planned' as const,
    sleeves,totalBuyUsd:format(total),remainingCashUsd:format(capital-total),
    targetCashUsd:format(capital*BigInt(spec.target.cashBps)/10000n),
    evidenceObservedAt:evidence.observedAt};
  // Preview identity only. It must never be used as an order-placement token.
  return {...plan,previewHash:fingerprint({plan,rules})};
}
