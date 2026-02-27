ALTER TABLE oracle_payments ADD COLUMN IF NOT EXISTS funded_by text NOT NULL DEFAULT 'platform';
