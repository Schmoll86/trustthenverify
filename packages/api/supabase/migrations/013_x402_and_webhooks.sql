-- x402 payment fields on escrows
ALTER TABLE escrows
  ADD COLUMN IF NOT EXISTS x402_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS x402_macaroon TEXT,
  ADD COLUMN IF NOT EXISTS x402_settlement_fee_cents INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS x402_seller_payout_tx TEXT;

-- Agent webhooks for instant notifications
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS webhook_url TEXT,
  ADD COLUMN IF NOT EXISTS webhook_secret TEXT;

-- x402 receipt audit trail
CREATE TABLE IF NOT EXISTS x402_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_id UUID NOT NULL REFERENCES escrows(id),
  tx_hash TEXT NOT NULL UNIQUE,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  amount_usdc BIGINT NOT NULL,
  block_number BIGINT NOT NULL,
  verified_at TIMESTAMPTZ DEFAULT NOW(),
  macaroon TEXT NOT NULL
);
