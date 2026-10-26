export const earningsCalendarMigration = { version: 81, name: 'Daily market-wide earnings calendar', sql: `
CREATE TABLE earnings_calendar_snapshots (
 sync_date date PRIMARY KEY,
 window_days integer NOT NULL CHECK (window_days BETWEEN 1 AND 31),
 payload jsonb NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT now()
);
` };
