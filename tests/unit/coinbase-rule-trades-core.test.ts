// Every Coinbase rule-trade test again, with the worker running
// as the Coinbase rebalance adapter of the shared action core. Same synthetic fixtures.
(globalThis as {ruleTradesViaCore?:boolean}).ruleTradesViaCore=true;
await import('./coinbase-order-reviews.test');
