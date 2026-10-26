// Financial history pruning was never scheduled, so nobody chose the stored 90-day
// default. Pruning now runs hourly; start at a year so the Portfolio 1Y chart keeps
// its synced history. A setting the member changes is left as they chose it.
export const financialRetentionDefaultMigration={version:37,name:'Financial history keeps a year by default',sql:`
UPDATE financial_history_settings SET retention_days=366 WHERE singleton AND retention_days=90;
ALTER TABLE financial_history_settings ALTER COLUMN retention_days SET DEFAULT 366;
`};
