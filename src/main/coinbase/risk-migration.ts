export const coinbaseRiskMigration={version:59,name:'Coinbase allocation risk limits',sql:`
ALTER TABLE coinbase_allocations
 ADD COLUMN risk_currency text CHECK(risk_currency IN ('USD','USDC')),
 ADD COLUMN max_daily_notional numeric(78,36) CHECK(max_daily_notional>=0),
 ADD COLUMN max_loss numeric(78,36) CHECK(max_loss>=0),
 ADD CHECK((max_daily_notional IS NULL AND max_loss IS NULL) OR risk_currency IS NOT NULL);
`};
