-- Phase 2: Add delivery tracking and timeout columns to escrows
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS delivery_attempts INTEGER DEFAULT 0;
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS timeout_seconds INTEGER DEFAULT 3600;

-- Policy coverage table for clause-to-constraint mapping
CREATE TABLE IF NOT EXISTS policy_coverage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id UUID REFERENCES policies(id) ON DELETE CASCADE,
  clause_index INTEGER NOT NULL,
  clause_text TEXT NOT NULL,
  constraint_ids TEXT[] DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'uncovered',
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- RLS for policy_coverage (same pattern as other tables)
ALTER TABLE policy_coverage ENABLE ROW LEVEL SECURITY;
