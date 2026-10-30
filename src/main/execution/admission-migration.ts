// When the core first handed a job to its adapter. Committed before any adapter
// lifecycle call, it is the core's only proof that the adapter never ran:
// `attempts` counts errors and `adapter_state` is optional, so both can read as
// fresh after a reservation or a submission. Every existing row is marked as
// started so nothing in flight is misread as fresh.
export const actionJobAdmissionMigration={version:117,name:'Action job started marker',sql:`
ALTER TABLE action_jobs ADD COLUMN started_at timestamptz;
UPDATE action_jobs SET started_at=created_at;
`};
