-- Phase 4: On-chain escrow support (Base L2)
-- Adds on-chain funding mode, addresses, and payment channels table.

-- Add on-chain columns to escrows
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS funding_mode text NOT NULL DEFAULT 'stripe';
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS buyer_address text;
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS seller_address text;
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS buyer_funded boolean NOT NULL DEFAULT false;
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS seller_funded boolean NOT NULL DEFAULT false;
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS chain_id integer;
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS tx_hash text;

-- Add accepted state to expiry index (for funding window timeout)
DROP INDEX IF EXISTS idx_escrows_expiry;
CREATE INDEX idx_escrows_expiry ON escrows (status, expires_at)
  WHERE status IN ('proposed', 'accepted', 'active');

-- Payment channels table
CREATE TABLE IF NOT EXISTS payment_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id uuid NOT NULL REFERENCES agents(id),
  seller_id uuid NOT NULL REFERENCES agents(id),
  buyer_address text NOT NULL,
  seller_address text NOT NULL,
  channel_address text,
  deposit_amount integer NOT NULL,
  spent_amount integer NOT NULL DEFAULT 0,
  chain_id integer NOT NULL,
  status text NOT NULL DEFAULT 'open',
  expiry_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS on payment_channels (service_role bypass, no anon access)
ALTER TABLE payment_channels ENABLE ROW LEVEL SECURITY;

-- Index for channel lookups
CREATE INDEX idx_payment_channels_status ON payment_channels (status)
  WHERE status = 'open';
CREATE INDEX idx_payment_channels_buyer ON payment_channels (buyer_id);
CREATE INDEX idx_payment_channels_seller ON payment_channels (seller_id);
