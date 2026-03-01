-- Phase 2: Email notifications
-- Adds email and notification preference columns to agents table.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS email TEXT DEFAULT NULL;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS notification_preferences JSONB DEFAULT '{
  "escrowProposed": true,
  "escrowAccepted": true,
  "deliverySubmitted": true,
  "verificationResult": true,
  "disputeFiled": true
}'::jsonb;
