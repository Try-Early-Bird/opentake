// A Take change an automatic rule run proposes is a pending suggestion; the
// member applies it (a copy becomes the draft) or dismisses it. Proposals are append-only,
// so a dismissal is its own record.
export const strategySuggestionMigration={version:107,name:'Dismiss rule-suggested Take changes',sql:`
CREATE TABLE strategy_suggestion_dismissals (
 proposal_id uuid PRIMARY KEY REFERENCES strategy_proposals(id) ON DELETE CASCADE,
 dismissed_at timestamptz NOT NULL DEFAULT now()
);
`};
