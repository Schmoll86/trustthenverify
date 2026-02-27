-- Phase 6: Oracle fee surcharge on escrows
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS oracle_fee_cents integer NOT NULL DEFAULT 0;

-- Phase 3: Policy marketplace fields
ALTER TABLE policies ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private';
ALTER TABLE policies ADD COLUMN IF NOT EXISTS usage_count integer NOT NULL DEFAULT 0;
ALTER TABLE policies ADD COLUMN IF NOT EXISTS billing_model text NOT NULL DEFAULT 'free';

-- Marketplace index for public listings
CREATE INDEX IF NOT EXISTS idx_policies_marketplace ON policies (status, visibility) WHERE visibility = 'public';
