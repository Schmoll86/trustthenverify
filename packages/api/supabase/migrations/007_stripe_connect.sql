-- Phase 7: Stripe Connect — agent Stripe identity + per-escrow Stripe tracking
-- Enables real money flow: buyer charges, seller payouts, collateral deposits

-- Agents: Stripe identity (all agents can be buyers, sellers, or both)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS stripe_connected_account_id TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS stripe_onboarding_complete BOOLEAN DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS stripe_default_payment_method TEXT;

-- Escrows: per-object Stripe tracking (two PIs for game-theoretic parity with on-chain)
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS stripe_buyer_pi_id TEXT;
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS stripe_seller_collateral_pi_id TEXT;
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS stripe_transfer_id TEXT;
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS buyer_payment_method_id TEXT;
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS seller_payment_method_id TEXT;
