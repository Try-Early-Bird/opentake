import type { Transaction } from '@electric-sql/pglite';
import type { createDatabaseLifecycle } from '../database';
import { basketSchema,assertInstrumentExecution } from '../../shared/strategies';
import { amount, format, unreleased } from '../allocations/ledger';
import { claimed, measuredCash } from '../allocations/evidence';
import { planFirstInvestment, previewRequestSchema, type PreviewEvidence, type PreviewRequest, type VenueSizingRules } from './first-investment';

type Database = Pick<ReturnType<typeof createDatabaseLifecycle>, 'use'>;
/** Internal read-only adapter. The host must supply fresh provider evidence,
 * never evidence from a renderer/model. No RPC or broker-write surface yet. */
export function createInvestmentPreview(database: Database, options: {
  rules: VenueSizingRules;
  evidence: (input: {accountId:string;venue:string;symbols:string[]}) => Promise<PreviewEvidence>;
  clock?: () => number;
}) {
  async function committed(tx: Transaction, request: PreviewRequest) {
    const row = (await tx.query<{spec:unknown;venue:string}>(`SELECT v.spec,c.venue FROM strategies s
      JOIN strategy_versions v ON v.strategy_id=s.id AND v.id=s.current_version_id
      JOIN platform_connections c ON c.owner_id=s.owner_id
      JOIN linked_accounts a ON a.connection_id=c.id
      WHERE s.id=$1 AND v.id=$2 AND a.id=$3 AND s.status='committed' AND s.archived_at IS NULL
      AND a.available AND a.selected AND a.agentic_allowed AND c.status='connected'`,
      [request.strategyId,request.versionId,request.accountId])).rows[0];
    if (!row) throw new Error('Current committed take and eligible account required');
    if (row.venue !== options.rules.venue) throw new Error('Unsupported account venue');
    const spec=basketSchema.parse(row.spec);assertInstrumentExecution(spec);
    return {...row,spec};
  }
  return async (raw: PreviewRequest) => {
    const request = previewRequestSchema.parse(raw);
    const initial = await database.use(db => db.transaction(tx => committed(tx,request)));
    const evidence = await options.evidence({accountId:request.accountId,venue:initial.venue,
      symbols:initial.spec.target.weights.filter(w => w.instrument.venue === initial.venue).map(w => w.instrument.symbol).sort()});
    // Provider I/O is outside the transaction. Recheck current version/account
    // and cash afterwards so an edit, disconnect or reservation cannot race it.
    return database.use(db => db.transaction(async tx => {
      const current = await committed(tx,request);
      const now = new Date((options.clock ?? Date.now)()).toISOString();
      if ((await tx.query(`SELECT 1 FROM strategy_allocations WHERE account_id=$1 AND restore_required
        AND status IN ${unreleased} LIMIT 1`,[request.accountId])).rows.length) throw new Error('Restore reconciliation required');
      if ((await tx.query(`SELECT 1 FROM strategy_reconciliation_cases WHERE account_id=$1 AND resolved_at IS NULL LIMIT 1`,[request.accountId])).rows.length) throw new Error('Resolve account reconciliation first');
      if ((await tx.query(`SELECT 1 FROM account_orders WHERE account_id=$1 AND NOT terminal LIMIT 1`,[request.accountId])).rows.length) throw new Error('Wait for open account orders');
      if ((await tx.query(`SELECT 1 FROM account_executions WHERE account_id=$1 AND attribution_state<>'completed' LIMIT 1`,[request.accountId])).rows.length) throw new Error('Wait for fill attribution');
      const cash = await measuredCash(tx,request.accountId,now);
      const claims = await claimed(tx,request.accountId,null);
      if (claims.some(c => amount(c.quantity)<0n)) throw new Error('Resolve negative allocation cash');
      const available = cash.cash - claims.reduce((sum,c) => sum+amount(c.quantity),0n);
      const plan = planFirstInvestment({request,spec:current.spec,evidence,availableCashUsd:format(available),now,rules:options.rules});
      return {...plan,cashObservationId:cash.observationId,cashObservedAt:cash.observedAt};
    }));
  };
}
