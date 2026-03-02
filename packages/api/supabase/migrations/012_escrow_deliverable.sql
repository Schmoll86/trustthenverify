-- Store deliverable JSON so the LLM arbitrator can review it during disputes (SPEC §3.4)
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS deliverable JSONB;
