export const coinbaseMarketOrderMigration={version:66,name:'Coinbase cash-sized market buy fills',sql:`
ALTER TABLE coinbase_allocation_orders ADD COLUMN quote_sized boolean NOT NULL DEFAULT false CHECK(NOT quote_sized OR side='buy');
`};
