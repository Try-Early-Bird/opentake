// Member instructions that wait. `details`
// holds what the member was shown (a withdrawal's preview legs, a close's
// chosen holdings, a re-confirmation stamp); the outcome code says who or
// what ended an instruction (`member` for a cancel, the superseding id).
export const instructionsMigration={version:35,name:'Instruction details and outcomes',sql:`
ALTER TABLE strategy_allocation_transactions
 ADD COLUMN details jsonb NOT NULL DEFAULT '{}',
 ADD COLUMN outcome_code text,
 ADD COLUMN outcome_at timestamptz,
 ADD COLUMN updated_at timestamptz;
`};
