// Allocations resumed before the resume step recorded their applied version
// still say sequence 0, which the planner reads as behind its strategy (a
// manual plan would rebalance them to target). Record the version they hold.
export const resumedSequenceMigration={version:36,name:'Resumed allocations record their applied version',sql:`
UPDATE strategy_allocations a SET applied_version_sequence=v.sequence,activated_at=coalesce(a.activated_at,a.updated_at)
FROM strategy_versions v WHERE v.id=a.applied_version_id AND a.applied_version_sequence=0
AND a.status IN ('active','paused','diverged') AND NOT a.restore_required
AND EXISTS(SELECT 1 FROM strategy_attribution_entries e WHERE e.allocation_id=a.id AND e.source_kind='development_import');
`};
