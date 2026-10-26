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
