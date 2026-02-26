-- Phase 6: Oracle Consensus Verification
-- 4 tables: oracle_pool, oracle_tasks, oracle_votes, oracle_payments

-- Oracle pool: agent opt-in registry
CREATE TABLE oracle_pool (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn')),
  capabilities TEXT[] NOT NULL DEFAULT '{}',
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  accuracy_score NUMERIC(5,4) NOT NULL DEFAULT 1.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id)
);

-- Oracle tasks: one per verification round
CREATE TABLE oracle_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_id UUID NOT NULL REFERENCES escrows(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'voting', 'decided', 'expired', 'failed')),
  quorum INTEGER NOT NULL DEFAULT 3,
  total_oracles INTEGER NOT NULL DEFAULT 5,
  consensus TEXT CHECK (consensus IN ('pass', 'fail', 'no_consensus')),
  deliverable JSONB NOT NULL,
  task_spec TEXT,
  policy_id UUID REFERENCES policies(id),
  votes_pass INTEGER NOT NULL DEFAULT 0,
  votes_fail INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Oracle votes: one per oracle per task
CREATE TABLE oracle_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  oracle_task_id UUID NOT NULL REFERENCES oracle_tasks(id),
  oracle_id UUID NOT NULL REFERENCES oracle_pool(id),
  agent_id UUID NOT NULL REFERENCES agents(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'expired')),
  verdict TEXT CHECK (verdict IN ('pass', 'fail')),
  rationale TEXT,
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (oracle_task_id, oracle_id)
);

-- Oracle payments: audit trail
CREATE TABLE oracle_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  oracle_task_id UUID NOT NULL REFERENCES oracle_tasks(id),
  oracle_id UUID NOT NULL REFERENCES oracle_pool(id),
  agent_id UUID NOT NULL REFERENCES agents(id),
  amount_cents INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_oracle_pool_status ON oracle_pool(status);
CREATE INDEX idx_oracle_pool_agent ON oracle_pool(agent_id);
CREATE INDEX idx_oracle_tasks_status ON oracle_tasks(status);
CREATE INDEX idx_oracle_tasks_escrow ON oracle_tasks(escrow_id);
CREATE INDEX idx_oracle_votes_task ON oracle_votes(oracle_task_id);
CREATE INDEX idx_oracle_votes_agent ON oracle_votes(agent_id);
CREATE INDEX idx_oracle_payments_status ON oracle_payments(status);

-- RLS (service_role bypasses, no permissive policies for anon)
ALTER TABLE oracle_pool ENABLE ROW LEVEL SECURITY;
ALTER TABLE oracle_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE oracle_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE oracle_payments ENABLE ROW LEVEL SECURITY;
