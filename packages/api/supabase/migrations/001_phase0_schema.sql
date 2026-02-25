-- Phase 0: Foundation schema (SPEC-v2 §6.3 + §6.4)

-- Agent registry
CREATE TABLE agents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_key      TEXT UNIQUE NOT NULL,
  endpoint        TEXT,
  name            TEXT,
  capabilities    JSONB DEFAULT '[]',
  metadata        JSONB DEFAULT '{}',
  parent_id       UUID REFERENCES agents(id),
  created_at      TIMESTAMPTZ DEFAULT now(),
  last_seen_at    TIMESTAMPTZ DEFAULT now()
);

-- Formal acceptance policies (reusable across transactions)
CREATE TABLE policies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  description     TEXT,
  intent          TEXT NOT NULL,
  formal_spec     JSONB NOT NULL,
  version         INTEGER DEFAULT 1,
  status          TEXT DEFAULT 'draft',
  billing         TEXT DEFAULT 'creator',
  tier2_used      BOOLEAN DEFAULT FALSE,
  translation_model TEXT,
  cross_validator   TEXT,
  cross_validation  JSONB,
  argus_budget    INTEGER,
  argus_coverage  FLOAT,
  argus_exploits  JSONB,
  parent_version  UUID REFERENCES policies(id),
  created_by      UUID REFERENCES agents(id),
  created_at      TIMESTAMPTZ DEFAULT now(),
  activated_at    TIMESTAMPTZ,
  deprecated_at   TIMESTAMPTZ
);

-- Coverage map: links NL clauses to constraints (§3.1.3)
CREATE TABLE policy_coverage (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id       UUID REFERENCES policies(id) ON DELETE CASCADE,
  clause_index    INTEGER NOT NULL,
  clause_text     TEXT NOT NULL,
  constraint_ids  TEXT[] NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL,
  note            TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- Escrow records
CREATE TABLE escrows (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_address    TEXT,
  stripe_escrow_id    TEXT,
  buyer_id            UUID REFERENCES agents(id),
  seller_id           UUID REFERENCES agents(id),
  amount_cents        INTEGER NOT NULL,
  seller_collateral   INTEGER NOT NULL,
  task_hash           TEXT NOT NULL,
  task_spec           JSONB NOT NULL,
  policy_id           UUID REFERENCES policies(id),
  verification_method TEXT DEFAULT 'buyer_confirm',
  dispute_resolution  TEXT DEFAULT 'burn',
  status              TEXT DEFAULT 'proposed',
  proof               TEXT,
  created_at          TIMESTAMPTZ DEFAULT now(),
  funded_at           TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ NOT NULL
);

-- Verification results (logged by Gateway)
CREATE TABLE verifications (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_id           UUID REFERENCES escrows(id),
  method              TEXT NOT NULL,
  policy_id           UUID REFERENCES policies(id),
  result              TEXT NOT NULL,
  constraints_total   INTEGER,
  constraints_passed  INTEGER,
  failure_details     JSONB,
  proof_hash          TEXT,
  gateway_signature   TEXT NOT NULL,
  verified_at         TIMESTAMPTZ DEFAULT now()
);

-- Disputes
CREATE TABLE disputes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_id       UUID REFERENCES escrows(id),
  initiator_id    UUID REFERENCES agents(id),
  reason          TEXT,
  evidence_hash   TEXT,
  arbitrator_id   UUID REFERENCES agents(id),
  ruling          TEXT,
  status          TEXT DEFAULT 'open',
  created_at      TIMESTAMPTZ DEFAULT now(),
  resolved_at     TIMESTAMPTZ
);

-- Attestations
CREATE TABLE attestations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id       UUID REFERENCES agents(id),
  subject_id      UUID REFERENCES agents(id),
  escrow_id       UUID REFERENCES escrows(id),
  outcome         TEXT NOT NULL,
  verification_method TEXT,
  signature       TEXT NOT NULL,
  nostr_event_id  TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- Indexes (§6.4)
CREATE UNIQUE INDEX idx_agents_pubkey ON agents(public_key);
CREATE INDEX idx_agents_capabilities ON agents USING GIN(capabilities);
CREATE INDEX idx_escrows_buyer ON escrows(buyer_id, status);
CREATE INDEX idx_escrows_seller ON escrows(seller_id, status);
CREATE INDEX idx_escrows_expires ON escrows(expires_at) WHERE status IN ('proposed','funded','active');
CREATE INDEX idx_policies_name ON policies(name, version DESC);
CREATE INDEX idx_policies_status ON policies(status) WHERE status = 'active';
CREATE INDEX idx_policy_coverage_policy ON policy_coverage(policy_id);
CREATE INDEX idx_policy_coverage_uncovered ON policy_coverage(policy_id) WHERE status = 'uncovered';
CREATE INDEX idx_verifications_escrow ON verifications(escrow_id);
CREATE INDEX idx_attestations_subject ON attestations(subject_id, created_at DESC);
