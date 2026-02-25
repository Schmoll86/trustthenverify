-- Phase 3: Argus Codex — refinement tracking table

CREATE TABLE refinements (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id         UUID REFERENCES policies(id) NOT NULL,
  status            TEXT DEFAULT 'running',    -- running | complete | failed
  budget            INTEGER NOT NULL DEFAULT 1000,
  current_round     INTEGER DEFAULT 0,
  last_exploit_round INTEGER DEFAULT 0,
  consecutive_clean INTEGER DEFAULT 0,
  working_spec      JSONB NOT NULL,
  exploits          JSONB DEFAULT '[]',
  coverage          FLOAT,
  tier2_introduced  BOOLEAN DEFAULT FALSE,
  error_message     TEXT,
  created_at        TIMESTAMPTZ DEFAULT now(),
  completed_at      TIMESTAMPTZ
);

ALTER TABLE refinements ENABLE ROW LEVEL SECURITY;
