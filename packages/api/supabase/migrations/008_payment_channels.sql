-- Phase 4b: Payment channels table
CREATE TABLE payment_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_address TEXT NOT NULL UNIQUE,
  buyer_id UUID REFERENCES agents(id),
  seller_id UUID REFERENCES agents(id),
  deposit_usdc NUMERIC NOT NULL,
  chain_id INTEGER NOT NULL,
  expiration TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ DEFAULT now(),
  closed_at TIMESTAMPTZ
);
ALTER TABLE payment_channels ENABLE ROW LEVEL SECURITY;
