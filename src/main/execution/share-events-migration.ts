// Share-count events and abandoned orders. `symbol_share_events` has the
// member in the operator's place: a forward split is
// applied on detection; a reverse split or a step that is not a simple
// fraction waits for the member to apply or dismiss it. `share_event_checks`
// remembers each symbol's last check so a restart neither re-reads a year of
// closes nor forgets that today's newest bar looked like an unadjusted split.
// An order of unknown outcome the member has checked against Robinhood
// becomes `abandoned`: it no longer blocks, yet a synced order with its ref_id
// is still matched to it.
export const shareEventsMigration={version:38,name:'Share-count events and abandoned orders',sql:`
CREATE TABLE symbol_share_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 symbol text NOT NULL CHECK(symbol ~ '^[A-Z][A-Z0-9.-]{0,11}$'),
 effective_on date NOT NULL,
 kind text NOT NULL CHECK(kind IN ('split','unclassified')),
 status text NOT NULL CHECK(status IN ('pending_review','applied','dismissed')),
 split_to integer CHECK(split_to>0), split_from integer CHECK(split_from>0),
 observed_step numeric(38,18) NOT NULL CHECK(observed_step>0),
 detected_on date NOT NULL,
 details jsonb NOT NULL DEFAULT '{}',
 decided_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(symbol,effective_on),
 CHECK(kind<>'split' OR (split_to IS NOT NULL AND split_from IS NOT NULL))
);
CREATE INDEX symbol_share_events_pending ON symbol_share_events(symbol) WHERE status='pending_review';
CREATE TABLE share_event_checks (
 symbol text PRIMARY KEY CHECK(symbol ~ '^[A-Z][A-Z0-9.-]{0,11}$'),
 checked_on date NOT NULL,
 unconfirmed_on date,
 failed boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE strategy_allocation_transactions DROP CONSTRAINT strategy_allocation_transactions_kind_check;
ALTER TABLE strategy_allocation_transactions ADD CONSTRAINT strategy_allocation_transactions_kind_check CHECK(kind IN
 ('investment','contribution','cash_release','version_change','rebalance','redemption','exit','detachment','reconciliation','reinvestment','corporate_action'));
ALTER TABLE order_intents DROP CONSTRAINT order_intents_status_check;
ALTER TABLE order_intents ADD CONSTRAINT order_intents_status_check CHECK(status IN ('reviewed','expired','placing','placed','rejected','placement_unknown','abandoned'));
`};
