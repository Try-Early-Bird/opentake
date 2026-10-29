// Limits for automatic (rule) agent runs, set in AI settings. Each is the
// default when a rule sets none and the maximum a rule may set.
export const automaticRunLimitsMigration={version:102,name:'Automatic run limits',sql:`
CREATE TABLE automatic_run_limits (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 duration_ms integer NOT NULL DEFAULT 300000 CHECK (duration_ms BETWEEN 1000 AND 3600000),
 tool_calls integer NOT NULL DEFAULT 20 CHECK (tool_calls BETWEEN 1 AND 100),
 model_turns integer NOT NULL DEFAULT 20 CHECK (model_turns BETWEEN 1 AND 20),
 cost_usd numeric NOT NULL DEFAULT 1.00 CHECK (cost_usd > 0 AND cost_usd <= 100),
 output_tokens integer NOT NULL DEFAULT 50000 CHECK (output_tokens BETWEEN 1 AND 10000000),
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO automatic_run_limits(singleton) VALUES(true);
`};
// Members run on their own AI subscriptions, so the ceilings sit well above
// what a careful run needs. Limits still on the old defaults move to the new ones.
// Chat responses get the same kind of limits, adjustable in AI settings.
export const automaticRunLimitsRaiseMigration={version:114,name:'Higher and adjustable run limits',sql:`
ALTER TABLE automatic_run_limits DROP CONSTRAINT automatic_run_limits_tool_calls_check, DROP CONSTRAINT automatic_run_limits_model_turns_check,
 ADD CONSTRAINT automatic_run_limits_tool_calls_check CHECK (tool_calls BETWEEN 1 AND 500),
 ADD CONSTRAINT automatic_run_limits_model_turns_check CHECK (model_turns BETWEEN 1 AND 200),
 ALTER COLUMN duration_ms SET DEFAULT 900000, ALTER COLUMN tool_calls SET DEFAULT 100, ALTER COLUMN model_turns SET DEFAULT 100;
UPDATE automatic_run_limits SET duration_ms=CASE WHEN duration_ms=300000 THEN 900000 ELSE duration_ms END,
 tool_calls=CASE WHEN tool_calls=20 THEN 100 ELSE tool_calls END, model_turns=CASE WHEN model_turns=20 THEN 100 ELSE model_turns END;
ALTER TABLE chat_budgets ADD COLUMN duration_ms integer NOT NULL DEFAULT 1800000 CHECK (duration_ms BETWEEN 60000 AND 3600000),
 ADD COLUMN tool_calls integer NOT NULL DEFAULT 200 CHECK (tool_calls BETWEEN 1 AND 500),
 ADD COLUMN model_turns integer NOT NULL DEFAULT 100 CHECK (model_turns BETWEEN 1 AND 200);
`};
