export const cryptoCashBaselineMigration={version:77,name:'Order cash reservation balance evidence',sql:`
ALTER TABLE order_cash_holds ADD COLUMN cash_before numeric(38,18);
ALTER TABLE order_cash_holds ADD CONSTRAINT order_cash_holds_baseline CHECK(cash_before IS NULL OR cash_before>=0);
`};
