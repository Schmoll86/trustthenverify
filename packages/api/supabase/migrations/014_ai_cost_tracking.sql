-- Workstream C: AI cost tracking for arbitration and translation.
-- Captures real OpenRouter usage.total_cost (rounded to USD cents) on the
-- canonical row for each call: translation cost lands on policies,
-- arbitration cost on disputes. Admin-only read surface exposes rolling
-- totals via GET /admin/costs. Append-only; never exposed on public API.

ALTER TABLE policies ADD COLUMN IF NOT EXISTS ai_cost_cents INTEGER DEFAULT 0;
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS ai_cost_cents INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_policies_created_at_cost
  ON policies (created_at) WHERE ai_cost_cents > 0;
CREATE INDEX IF NOT EXISTS idx_disputes_resolved_at_cost
  ON disputes (resolved_at) WHERE ai_cost_cents > 0;
