export const ruleApprovalMigration={version:96,name:'Persistent rule trade approvals and quote revisions',sql:`
ALTER TABLE strategy_rule_trades ADD COLUMN approval_pending boolean NOT NULL DEFAULT false;
UPDATE strategy_rule_trades j SET approval_pending=true
 FROM coinbase_order_reviews v,strategy_rule_action_requests r
 WHERE j.review_id=v.id AND r.id=j.request_id AND j.state='working' AND v.state='confirmed'
 AND (r.evidence->'rule'->'policy'->>'approval'='ask' OR coalesce((SELECT confirm_trades FROM trading_preferences LIMIT 1),false))
 AND NOT EXISTS(SELECT 1 FROM coinbase_order_dispatches d WHERE d.review_id=v.id);
UPDATE notifications n SET expires_at=NULL,payload=payload-'expiresAt' WHERE payload->>'eventKey'='rule-rebalance' AND EXISTS(SELECT 1 FROM strategy_rule_trades j WHERE j.request_id::text=n.payload->'source'->>'id' AND j.approval_pending AND j.state='working');
DROP INDEX coinbase_rule_review_identity;
CREATE UNIQUE INDEX coinbase_rule_review_identity ON coinbase_order_reviews
 ((payload->'rebalance'->>'ruleRequestId'),(coalesce(payload->'rebalance'->>'phase','initial')),(coalesce(payload->'rebalance'->>'quoteRevision','0')))
 WHERE payload->'rebalance'->>'ruleRequestId' IS NOT NULL;
`};
