export const mixedLifecycleMigration={version:71,name:'Mixed Take terminal outcomes',sql:`
ALTER TABLE mixed_take_execution_legs DROP CONSTRAINT mixed_take_execution_legs_state_check;
ALTER TABLE mixed_take_execution_legs ADD CONSTRAINT mixed_take_execution_legs_state_check CHECK(state IN ('reserved','dispatching','pending','waiting_market','completed','partial','cancelled','attention'));
`};
