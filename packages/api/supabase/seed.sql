-- Seed: Pre-built policy templates (SPEC-v2 §10.3)
-- These are platform-provided, Argus-refined templates for common task types.

INSERT INTO policies (name, description, intent, formal_spec, version, status, billing, tier2_used, argus_budget, argus_coverage) VALUES
(
  'web_search_v1',
  'Pre-built template for search result verification',
  'Verify that web search results contain valid, recent URLs with non-empty snippets',
  '{
    "constraints": [
      {"id": "ws1", "type": "count_range", "field": "results", "min": 1, "max": 50, "description": "Result count within expected range"},
      {"id": "ws2", "type": "format", "field": "results[*].url", "pattern": "^https?://", "description": "All URLs are valid HTTP(S)"},
      {"id": "ws3", "type": "recency", "field": "results[*].date", "max_age_days": 365, "description": "Results within date recency window"},
      {"id": "ws4", "type": "non_empty", "field": "results[*].snippet", "description": "All result snippets are non-empty"}
    ],
    "version": "1.0"
  }'::jsonb,
  1, 'active', 'platform', false, 1000, 0.95
),
(
  'summarization_v1',
  'Pre-built template for text summarization verification',
  'Verify that summaries meet length, structure, and coherence requirements',
  '{
    "constraints": [
      {"id": "sm1", "type": "word_count_range", "field": "summary", "min": 20, "max": 500, "description": "Summary word count within range"},
      {"id": "sm2", "type": "sentence_count_range", "field": "summary", "min": 1, "max": 20, "description": "Sentence count within range"},
      {"id": "sm3", "type": "overlap_ratio", "field": "summary", "reference": "source", "max": 0.30, "description": "Less than 30% overlap with source text"},
      {"id": "sm4", "type": "semantic", "field": "summary", "check": "coherence", "tier": 2, "description": "Summary is coherent and relevant to source"}
    ],
    "version": "1.0"
  }'::jsonb,
  1, 'active', 'platform', true, 1000, 0.92
),
(
  'data_retrieval_v1',
  'Pre-built template for structured data retrieval verification',
  'Verify that returned data conforms to JSON schema with required fields and correct types',
  '{
    "constraints": [
      {"id": "dr1", "type": "json_schema", "field": "data", "description": "Output conforms to expected JSON schema"},
      {"id": "dr2", "type": "required_fields", "field": "data", "description": "All required fields are present"},
      {"id": "dr3", "type": "type_check", "field": "data.*", "description": "All field values match expected types"},
      {"id": "dr4", "type": "non_null", "field": "data.*", "description": "No null values in required fields"}
    ],
    "version": "1.0"
  }'::jsonb,
  1, 'active', 'platform', false, 1000, 0.98
),
(
  'code_execution_v1',
  'Pre-built template for code execution output verification',
  'Verify code output format, absence of errors, and deterministic reproducibility',
  '{
    "constraints": [
      {"id": "ce1", "type": "format", "field": "output", "required_keys": ["stdout", "stderr", "exit_code"], "description": "Output contains stdout, stderr, and exit_code"},
      {"id": "ce2", "type": "pattern_absent", "field": "output.stderr", "patterns": ["Error", "Exception", "Traceback"], "description": "No error strings in stderr"},
      {"id": "ce3", "type": "equals", "field": "output.exit_code", "value": 0, "description": "Exit code is 0"},
      {"id": "ce4", "type": "deterministic", "field": "output.stdout", "reruns": 2, "description": "Output matches on deterministic re-run"}
    ],
    "version": "1.0"
  }'::jsonb,
  1, 'active', 'platform', false, 1000, 0.97
),
(
  'translation_v1',
  'Pre-built template for language translation verification',
  'Verify translation language detection, length ratio, and completeness',
  '{
    "constraints": [
      {"id": "tr1", "type": "language_detect", "field": "output", "must_match": "target_language", "description": "Output is in the target language"},
      {"id": "tr2", "type": "language_detect", "field": "input", "must_match": "source_language", "description": "Input is in the source language"},
      {"id": "tr3", "type": "length_ratio", "field": "output", "reference": "input", "min": 0.7, "max": 1.5, "description": "Translation length ratio within 0.7-1.5x of source"},
      {"id": "tr4", "type": "semantic", "field": "output", "check": "completeness", "tier": 2, "description": "Translation is complete (no truncation)"}
    ],
    "version": "1.0"
  }'::jsonb,
  1, 'active', 'platform', true, 1000, 0.90
)
ON CONFLICT DO NOTHING;
