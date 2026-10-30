// The last three tables that listed venues in a CHECK now reference `venues`,
// like action_jobs and watchlists already do. The same two values are allowed
// today; a future venue is one appended INSERT INTO venues, with no constraint
// to widen. The CHECKs were created inline, so they are found by shape (the
// single-column check on `venue`) rather than by an assumed name.
export const venuesAsDataMigration={version:118,name:'Venue tables reference venues',sql:`
DO $$
DECLARE t text; c text;
BEGIN
 FOREACH t IN ARRAY ARRAY['strategy_account_routes','order_activity','mixed_take_execution_legs'] LOOP
  FOR c IN
   SELECT conname FROM pg_constraint
   WHERE conrelid=t::regclass AND contype='c'
    AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=t::regclass AND attname='venue')]
  LOOP
   EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',t,c);
  END LOOP;
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (venue) REFERENCES venues(id)',t,t||'_venue_fkey');
 END LOOP;
END $$;
`};
