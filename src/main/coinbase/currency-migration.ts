export const coinbaseCurrencyMigration={version:54,name:'Coinbase execution currency accounting',sql:`
CREATE TABLE coinbase_execution_movements (
 account_id uuid NOT NULL,
 provider text NOT NULL DEFAULT 'coinbase' CHECK(provider='coinbase'),
 execution_ref text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('base','quote','fee')),
 asset text NOT NULL,
 quantity numeric(78,36) NOT NULL,
 exact boolean NOT NULL,
 PRIMARY KEY(account_id,execution_ref,kind),
 FOREIGN KEY(account_id,provider,execution_ref) REFERENCES account_executions(account_id,provider,provider_ref) ON DELETE RESTRICT
);
CREATE TRIGGER coinbase_movements_immutable BEFORE UPDATE OR DELETE ON coinbase_execution_movements
 FOR EACH ROW EXECUTE FUNCTION strategy_immutable_row();
`};
