// Migration 34 seeded allocation_value from the local ledger's capital
// entries, but an imported allocation keeps its capital history in the
// immutable source ledger (strategy_portfolio_imports.source_data), so its
// value came out 0. Withdrawals settle against allocation_value (0 minus the
// proceeds would never release them) and the planner caps orders with it.
// Hosted's allocation_value is the net capital put in; recompute it from the
// source ledger plus any local capital since the import, for imported
// allocations still at 0.
export const importedAllocationValueMigration={version:40,name:'Imported allocations carry their capital',sql:`
UPDATE strategy_allocations a SET allocation_value=greatest(0,src.capital+coalesce((SELECT sum(e.cash_delta) FROM strategy_attribution_entries e
  WHERE e.allocation_id=a.id AND e.entry_type IN ('capital_allocated','capital_released') AND e.source_kind<>'development_import'),0))
FROM (
 SELECT (i.mapping->'allocations'->>(al->>'id'))::uuid AS allocation_id,
  coalesce(sum((en->>'cashDelta')::numeric) FILTER (WHERE en->>'entryType' IN ('capital_allocated','capital_released')),0) AS capital
 FROM strategy_portfolio_imports i CROSS JOIN LATERAL jsonb_array_elements(i.source_data->'allocations') al
  LEFT JOIN LATERAL jsonb_array_elements(al->'entries') en ON true
 GROUP BY 1
) src
WHERE a.id=src.allocation_id AND a.allocation_value=0 AND a.status IN ('active','paused','diverged');
`};
