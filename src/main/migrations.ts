import {eventInboxMigration} from './data-sources/event-inbox-migration';
import {metadataTimestampsMigration} from './data-sources/metadata-timestamps-migration';
import {ruleApprovalMigration} from './strategies/rule-approval-migration';
import {ruleTradeMigration} from './strategies/rule-trade-migration';
import {ruleNotificationsMigration} from './strategies/rule-notifications-migration';
import {ruleProposalMigration} from './strategies/rule-proposal-migration';
import {ruleRetentionMigration} from './strategies/rule-retention-migration';
import {ruleContextMigration} from './strategies/rule-context-migration';
import {ruleRunnerMigration} from './strategies/rule-runner-migration';
import {ruleDraftMigration} from './strategies/rule-draft-migration';
import {coinbaseValuationSnapshotMigration} from './coinbase/valuation-snapshot-migration';
import {takeInputMigration} from './data-sources/take-input-migration';
import {accountSourceSettingsMigration} from './data-sources/account-settings-migration';
import { managedSourceSettingsMigration } from './data-sources/managed-settings-migration';
import { dataSourceDestinationMigration } from './data-sources/destination-migration';
import { dataSourceStorageMigration } from './data-sources/migration';
import { documentMigration } from './document-migration';
import {earningsCalendarMigration} from './market-series/earnings-calendar-migration';
import {cryptoModelMigration} from './assets/crypto-model-migration';
import {cryptoTrackingMigration} from './assets/crypto-tracking-migration';
import {cryptoObservationMigration} from './orders/crypto-observation-migration';
import {cryptoCashBaselineMigration} from './orders/crypto-cash-baseline-migration';
import {cryptoUnitMigration} from './orders/crypto-unit-migration';
import {mixedWithdrawalMigration} from './mixed-execution/withdrawal-migration';
import {mixedLifecycleMigration} from './mixed-execution/lifecycle-migration';
import {mixedExecutionMigration} from './mixed-execution/execution-migration';
import {mixedPreviewMigration} from './mixed-execution/migration';
import {versionAdoptionMigration} from './allocations/version-adoption-migration';
import {coinbaseRebalanceWarningDetailsMigration} from './coinbase/rebalance-warning-details-migration';
import {coinbaseMarketOrderMigration} from './coinbase/market-order-migration';
import {coinbaseRebalanceStatusMigration} from './coinbase/rebalance-status-migration';
import {coinbaseLifecycleMigration} from './coinbase/lifecycle-migration';
import {coinbaseAutomationMigration} from './coinbase/automation-migration';
import {coinbaseInvestmentMigration} from './coinbase/investment-migration';
import {coinbaseSyncRetryMigration} from './coinbase/sync-retry-migration';
import {orderActivityMigration} from './trading/activity-migration';
import {coinbaseRiskMigration} from './coinbase/risk-migration';
import { coinbaseDispatchMigration } from './coinbase/dispatch-migration';
import { coinbaseOrderReviewMigration } from './coinbase/order-review-migration';
import { coinbaseCapitalMigration } from './coinbase/capital-migration';
import { coinbaseAllocationMigration } from './coinbase/allocation-migration';
import { coinbaseCurrencyMigration } from './coinbase/currency-migration';
import { publicPriceCacheMigration } from './coinbase/price-cache';
import { coinbaseActivityMigration } from './coinbase/activity-migration';
import { coinbaseHistoryMigration } from './coinbase/history-migration';
import { searchGramsCompatibilityMigration } from './search/compatibility-migration';
import { MigrationHistoryError } from './migration-error';
import { strategyAccountPlanMigration } from './strategies/account-plan-migration';
import { coinbasePortfolioMigration } from './coinbase/portfolio-migration';
import { localSearchIndexMigration } from './search/migration';
import { coinbaseConnectionMigration } from './coinbase/migration';
import { takeIconMigration } from './take-icon-migration';
import {executionReliabilityMigration} from './execution/reliability-migration';
import {strategyPortfolioImportMigration} from './allocations/import-migration';
import {priceStoreMigration,seriesCacheMigration} from './market-series/price-store-migration';
import {cryptoLedgerMigration} from './orders/crypto-ledger-migration';
import {cryptoFillMigration} from './orders/crypto-fill-migration';
import {cryptoJournalMigration} from './orders/crypto-journal-migration';
import {orderIntentsMigration} from './orders/migration';
import {shareEventsMigration} from './execution/share-events-migration';
import {delistingMigration} from './execution/delisting-migration';
import {importedAllocationValueMigration} from './allocations/import-value-migration'
import {archiveClosureMigration,archiveClosureGuardMigration} from './execution/archive-closure-migration'
import {importLotsMigration} from './allocations/import-lots-migration';
import {executionMigration} from './execution/migration';
import {instructionsMigration} from './execution/instructions-migration';
import {resumedSequenceMigration} from './execution/resumed-sequence-migration';
import {financialRetentionDefaultMigration} from './allocations/retention-default-migration';
import { strategyAuthoringMigration } from './strategies/migration';
import { allocationMigration } from './allocations/migration';
import { portfolioHistoryImportMigration } from './account-sync/history-import-migration';
import { accountSyncMigration } from './account-sync/migration';
import { usageBudgetMigration } from './usage-budget-migration';
import { notificationRecoveryMigration } from './notification-recovery-migration';
import { takeContextMigration } from './take-context-migration';
import { notificationsMigration } from './notifications-migration';
import { chatUsageMigration } from './chat-usage-migration';
import { takePermissionModeMigration } from './take-permission-mode-migration';
import { mcpMetadataMigration } from './mcp-metadata-migration';
import { mcpOAuthMigration } from './mcp-oauth-migration';
import { aiAuditMigration } from './ai-audit-migration';
import { aiAuditRetentionMigration } from './ai-audit-retention-migration';
import { recoverAiAudits } from './ai-audit';
import { toolApprovalModeMigration } from './tool-approval-mode-migration';
import { generalInstructionsMigration } from './general-instructions-migration';
import { toolGovernanceMigration } from './tool-governance-migration';
import { platformAccessMigration } from './platform-access-migration';
import { instructionModeMigration } from './instruction-mode-migration';
import { approvalExpiryMigration } from './approval-expiry-migration';
import { instructionProfilesMigration } from './instruction-profiles-migration';
import { instructionOrderMigration } from './instruction-order-migration';
import { takeIntegrityMigration } from './take-integrity-migration';
import { jobDiagnosticsMigration } from './job-diagnostics-migration';
import { takeMigration } from './take-migration';
import { ruleIndexMigration } from './strategies/rule-index-migration';
import { actionJobMigration } from './execution/action-job-migration';
import { ruleAgentMigration } from './strategies/rule-agent-migration';
import { ruleSwitchMigration } from './strategies/rule-switch-migration';
import { toolChangeMigration } from './tool-change-migration';
import { toolChangedAtMigration } from './tool-changed-at-migration';
import { toolTrustMigration } from './tool-trust-migration';
import { strategySuggestionMigration } from './strategies/suggestion-migration';
import { ruleProducerMigration } from './strategies/rule-producer-migration';
import { robinhoodRuleTradeMigration, robinhoodDeployCashMigration } from './strategies/robinhood-rule-trade-migration';
import { automaticRunLimitsMigration } from './automatic-run-limits-migration';
import { watchlistMigration } from './watchlists/migration';
import { createHash } from 'node:crypto';
import type { DatabaseClient as PGlite } from './database-client';

// Append-only. Never edit an applied migration: add a new version instead.
export const migrations = [{ version: 1, name: 'Local owner and platform connections', sql: `
CREATE TABLE local_owners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO local_owners DEFAULT VALUES;
CREATE TABLE platform_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES local_owners(id),
  venue text NOT NULL,
  credential_ref text,
  status text NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected', 'connected', 'reauth_required')),
  checked_at timestamptz,
  UNIQUE (owner_id, venue)
);
CREATE TABLE linked_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES platform_connections(id) ON DELETE CASCADE,
  external_ref text NOT NULL,
  masked_number text NOT NULL,
  nickname text,
  account_type text,
  agentic_allowed boolean NOT NULL DEFAULT false,
  selected boolean NOT NULL DEFAULT false,
  UNIQUE (connection_id, external_ref)
);
CREATE UNIQUE INDEX one_selected_account ON linked_accounts(connection_id) WHERE selected;
` }, { version: 2, name: 'Background account maintenance queue', sql: `
CREATE TABLE background_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES platform_connections(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind = 'account_sync'),
  state text NOT NULL CHECK (state IN ('pending','running','retrying','completed','failed','needs_attention','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  reason text NOT NULL,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  next_run_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_active_sync ON background_jobs(connection_id, kind)
  WHERE state IN ('pending','running','retrying');
ALTER TABLE platform_connections ADD COLUMN maintenance_enabled boolean NOT NULL DEFAULT false;
UPDATE platform_connections SET maintenance_enabled = true WHERE status = 'connected';
` }, takeMigration, { version: 4, name: 'Job history pagination', sql: `
CREATE INDEX background_jobs_history ON background_jobs(updated_at DESC, id DESC)
  WHERE state IN ('completed','cancelled','failed');
` }, jobDiagnosticsMigration, takeIntegrityMigration, instructionOrderMigration, approvalExpiryMigration, instructionProfilesMigration, instructionModeMigration, platformAccessMigration, toolGovernanceMigration, toolApprovalModeMigration, generalInstructionsMigration, aiAuditMigration, mcpOAuthMigration, aiAuditRetentionMigration, mcpMetadataMigration, takePermissionModeMigration, chatUsageMigration, notificationsMigration, takeContextMigration, notificationRecoveryMigration, usageBudgetMigration, accountSyncMigration, portfolioHistoryImportMigration, allocationMigration, strategyAuthoringMigration, strategyPortfolioImportMigration, {version:30,name:'Account options capability',sql:'ALTER TABLE linked_accounts ADD COLUMN option_level TEXT;'}, priceStoreMigration, seriesCacheMigration, orderIntentsMigration, executionMigration, instructionsMigration, resumedSequenceMigration, financialRetentionDefaultMigration, shareEventsMigration, delistingMigration, importedAllocationValueMigration, archiveClosureMigration, archiveClosureGuardMigration, importLotsMigration, executionReliabilityMigration, takeIconMigration, localSearchIndexMigration, coinbaseConnectionMigration, coinbasePortfolioMigration, strategyAccountPlanMigration, searchGramsCompatibilityMigration, coinbaseHistoryMigration, coinbaseActivityMigration, publicPriceCacheMigration, coinbaseCurrencyMigration, coinbaseAllocationMigration, coinbaseCapitalMigration, coinbaseOrderReviewMigration, coinbaseDispatchMigration, coinbaseRiskMigration, orderActivityMigration, coinbaseSyncRetryMigration, coinbaseInvestmentMigration, coinbaseAutomationMigration, coinbaseLifecycleMigration, coinbaseRebalanceStatusMigration, coinbaseMarketOrderMigration, coinbaseRebalanceWarningDetailsMigration, versionAdoptionMigration, mixedPreviewMigration, mixedExecutionMigration, mixedLifecycleMigration, mixedWithdrawalMigration, cryptoJournalMigration, cryptoFillMigration, cryptoLedgerMigration, cryptoUnitMigration, cryptoCashBaselineMigration, cryptoObservationMigration, cryptoTrackingMigration, cryptoModelMigration, earningsCalendarMigration, documentMigration, dataSourceStorageMigration, dataSourceDestinationMigration, managedSourceSettingsMigration, accountSourceSettingsMigration, takeInputMigration, coinbaseValuationSnapshotMigration, ruleDraftMigration, ruleRunnerMigration, ruleContextMigration, ruleRetentionMigration, ruleProposalMigration, ruleNotificationsMigration, ruleTradeMigration, ruleApprovalMigration, metadataTimestampsMigration, eventInboxMigration, ruleIndexMigration, actionJobMigration, ruleAgentMigration, automaticRunLimitsMigration, ruleSwitchMigration, toolChangeMigration, toolChangedAtMigration, toolTrustMigration, strategySuggestionMigration, ruleProducerMigration, robinhoodRuleTradeMigration, robinhoodDeployCashMigration, watchlistMigration];

export async function migrationHistory(db: PGlite) {
  const result = await db.query<{ version: number; name: string; appliedAt: string }>(
    'SELECT version, name, applied_at::text AS "appliedAt" FROM app_migrations ORDER BY version DESC');
  return result.rows;
}

export async function pendingMigrations(db: PGlite, definitions = migrations) {
  const exists = (await db.query<{ name: string | null }>("SELECT to_regclass('public.app_migrations')::text AS name")).rows[0]?.name;
  if (!exists) return definitions;
  const applied = (await db.query<{ version: number; checksum: string }>(
    'SELECT version, checksum FROM app_migrations ORDER BY version')).rows;
  const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex');
  // A development watcher briefly shipped instruction profiles as v8 before
  // approval expiry shipped. Recognize only that exact, known SQL checksum.
  // Preserve its ledger: v8 remains profiles, v9 adds approvals, v10+ is shared.
  // Never rewrite applied versions/checksums or accept arbitrary schema drift.
  const profilesFirst = definitions === migrations && applied.some(row =>
    row.version === 8 && row.checksum === checksum(instructionProfilesMigration.sql));
  const profilePlan = profilesFirst ? definitions.map(definition =>
    definition.version === 8 ? { ...instructionProfilesMigration, version: 8 }
      : definition.version === 9 ? { ...approvalExpiryMigration, version: 9 } : definition) : definitions;
  // A concurrent development build shipped v12 with approval_mode already
  // named. Match only that recorded checksum, retaining its original ledger.
  // Its v13 validates the existing column instead of trying to rename it again.
  const approvalModeFirst = definitions === migrations && applied.some(row =>
    row.version === 12 && row.checksum === '2ff31d86bef0eae691e8f36f9f5647ab278cf2ca2cc38206b178cf1ed8684771');
  const approvalPlan = approvalModeFirst ? profilePlan.map(definition =>
    definition.version === 12 ? { ...toolGovernanceMigration,
      sql: toolGovernanceMigration.sql.replace('"authorization" text', '"approval_mode" text') }
      : definition.version === 13 ? { ...toolApprovalModeMigration,
        sql: '\nSELECT approval_mode FROM tool_invocations LIMIT 0;\n' } : definition) : profilePlan;
  // This worktree previously applied Coinbase as v46 while local dev used v46
  // for search. Preserve that exact applied ledger and append search as v47.
  // Canonical/new databases use local-dev search v46, then Coinbase v47.
  const coinbaseFirst = definitions === migrations && applied.some(row =>
    row.version === 46 && row.checksum === 'fd3b5069c958b0246664a8cf50b0d9b6de95d6f49235ca3d6b6d50dc770a47f5');
  const planned = coinbaseFirst ? approvalPlan.map(definition =>
    definition.version === 46 ? { ...coinbaseConnectionMigration, version: 46 }
      : definition.version === 47 ? { ...localSearchIndexMigration, version: 47 } : definition) : approvalPlan;
  // Verified original search v46 (before the position -> gram_start alias fix).
  // Only this exact checksum selects the old definition. v50 repairs forward.
  const legacySearch = definitions === migrations && applied.some(row =>
    row.version === 46 && row.checksum === '76a60fbf7e21fae9e11c8c5105717a730f85862a8e5ba87f343a62091fff3a7c');
  const compatible = legacySearch ? planned.map(definition => definition.version === 46
    ? { ...localSearchIndexMigration, sql: localSearchIndexMigration.sql.replaceAll('gram_start', 'position') }
    : definition) : planned;
  for (const [index, row] of applied.entries()) {
    const expected = compatible[index];
    if (!expected || row.version !== expected.version || row.checksum !== checksum(expected.sql)) {
      throw new MigrationHistoryError({version:row.version,storedChecksum:row.checksum,expectedChecksum:expected?.version===row.version?checksum(expected.sql):null,latestSupportedVersion:compatible.at(-1)?.version??0});
    }
  }
  return compatible.slice(applied.length);
}

export async function migrate(db: PGlite, definitions = migrations): Promise<void> {
  const pending = await pendingMigrations(db, definitions);
  await db.exec(`CREATE TABLE IF NOT EXISTS app_migrations (
    version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex');
  for (const definition of pending) {
    await db.transaction(async tx => {
      await tx.exec(definition.sql);
      await tx.query('INSERT INTO app_migrations(version, name, checksum) VALUES ($1, $2, $3)',
        [definition.version, definition.name, checksum(definition.sql)]);
    });
  }
}

export async function prepareRestoredDatabase(db: PGlite): Promise<void> {
  await migrate(db);
  await db.exec("UPDATE strategy_rule_accepted SET trading_enabled=false,trading_rule_ids='{}';");
  await db.exec("UPDATE strategy_rule_shadow SET enabled=false,notifications_enabled=false;");
  await db.exec("UPDATE data_sources SET enabled=false,validated=false; DELETE FROM data_source_latest; DELETE FROM strategy_rule_event_inbox;");
  await db.exec("UPDATE coinbase_order_reviews SET state='expired' WHERE state='preview';");
  await db.exec("UPDATE coinbase_capital_reviews SET state='expired' WHERE state='pending';");
  await db.exec("UPDATE coinbase_allocations SET status='paused',restore_required=true;");
  await db.exec("UPDATE strategy_allocations SET status='paused',restore_required=true,updated_at=now() WHERE status IN ('active','paused','diverged');");
  await db.exec("UPDATE account_sync_runs SET state='interrupted',finished_at=now(),error_code='restored_backup' WHERE state='running'; DELETE FROM account_sync_checkpoints;");
  await db.transaction(tx=>recoverAiAudits(tx,'restored_backup'));
  await db.exec(`UPDATE take_runs SET state='interrupted', finished_at=now() WHERE state IN ('starting','running','stopping');
    UPDATE take_messages SET data=jsonb_set(data, '{state}', '"interrupted"') WHERE data->>'state' IN ('starting','running','stopping');
    UPDATE tool_approvals SET state='expired' WHERE state IN ('pending','approved'); UPDATE mcp_servers SET enabled=false;`);
  // A backup may come from someone else: its own MCP servers' tool permissions and update trust start over.
  // The built-in server's id is fixed (mcp-management.ts); its tools ship with the app.
  await db.exec(`UPDATE mcp_tools SET policy='blocked' WHERE server_id<>'00000000-0000-4000-8000-000000000001';
    UPDATE mcp_servers SET trust_updates=false;`);
  await db.exec(`DELETE FROM platform_access_grants;
    UPDATE platform_access_requests SET state='expired' WHERE state IN ('pending','approved');
    UPDATE platform_access_settings SET revision=revision+1;`);
  await db.exec(`UPDATE tool_invocations SET state='interrupted',finished_at=now(),approval_mode=CASE WHEN approval_mode='pending' THEN 'expired' ELSE approval_mode END,detail='Restored before completion; outcome may be unknown.' WHERE finished_at IS NULL;`);
  await db.exec("UPDATE mcp_oauth_connections SET credential_ref=NULL,state='disconnected';");
  // Never reactivate imported references against secrets already on this device.
  await db.exec(`UPDATE platform_connections SET credential_ref = NULL, status = 'reauth_required', checked_at = NULL;
    UPDATE linked_accounts SET selected = false;
    UPDATE platform_connections SET maintenance_enabled = false;
    UPDATE background_jobs SET state = 'cancelled', error_code = 'restored_backup', updated_at = now()
      WHERE state IN ('pending','running','retrying','needs_attention');`);
  // A restored action never resumes on its own: it may predate newer account activity.
  await db.exec("UPDATE action_jobs SET state='cancelled',waiting_for=NULL,reason='restored_backup',updated_at=now() WHERE state IN ('queued','running','waiting');");
  await db.exec(`UPDATE notifications SET delivery='suppressed', resolved_at=coalesce(resolved_at,now());
    UPDATE notification_delivery SET navigation=NULL;`);
}
