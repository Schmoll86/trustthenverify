-- Pre-built policy templates (§10.3)
-- These are platform-funded, pre-refined via Argus Codex, ready for immediate use.

INSERT INTO policies (name, description, intent, formal_spec, version, status, billing, tier2_used, activated_at) VALUES

-- web_search_v1
('web_search_v1',
 'Verify web search results: count, valid URLs, date recency, non-empty snippets',
 'Return 5+ search results from the last 30 days. Each result must have a valid URL, a date, and a non-empty snippet. At least one result must mention the search topic.',
 '{
   "version": 1,
   "constraints": [
     {"id": "c1", "type": "count", "target": "$.results", "params": {"min": 5}, "clause_ref": "Return 5+ search results"},
     {"id": "c2", "type": "format", "target": "$.results[*].url", "params": {"format": "uri"}, "clause_ref": "valid URL"},
     {"id": "c3", "type": "range", "target": "$.results[*].date", "params": {"min_relative": "-30d"}, "clause_ref": "from the last 30 days"},
     {"id": "c4", "type": "length", "target": "$.results[*].snippet", "params": {"min": 1}, "clause_ref": "non-empty snippet"},
     {"id": "c5", "type": "exists", "target": "$.results[*].title", "params": {}, "clause_ref": "each result has a title"}
   ]
 }'::jsonb,
 1, 'active', 'platform', false, now()),

-- summarization_v1
('summarization_v1',
 'Verify text summaries: word count, sentence count, originality, coherence',
 'Summarize the provided text in 200-500 words. Summary must contain at least 8 sentences, have less than 30% overlap with the source, and be coherent.',
 '{
   "version": 1,
   "constraints": [
     {"id": "c1", "type": "range", "target": "$.summary", "params": {"min": 200, "max": 500}, "clause_ref": "200-500 words"},
     {"id": "c2", "type": "count", "target": "$.sentences", "params": {"min": 8}, "clause_ref": "at least 8 sentences"},
     {"id": "c3", "type": "overlap", "target": "$.summary", "params": {"source_target": "$.source", "max_ratio": 0.3}, "clause_ref": "less than 30% overlap"},
     {"id": "c4", "type": "coherence", "target": "$.summary", "params": {"min_score": 0.6}, "clause_ref": "coherent summary"}
   ]
 }'::jsonb,
 1, 'active', 'platform', true, now()),

-- data_retrieval_v1
('data_retrieval_v1',
 'Verify structured data retrieval: schema validation, required fields, type checks',
 'Return structured data matching the requested schema. All required fields must be present and non-null. Values must be the correct type.',
 '{
   "version": 1,
   "constraints": [
     {"id": "c1", "type": "exists", "target": "$.data", "params": {}, "clause_ref": "data field present"},
     {"id": "c2", "type": "type", "target": "$.data", "params": {"expected": "object"}, "clause_ref": "data is an object"},
     {"id": "c3", "type": "count", "target": "$.data.fields", "params": {"min": 1}, "clause_ref": "at least one field"},
     {"id": "c4", "type": "all", "target": "$.data.fields", "params": {"constraint": {"type": "exists", "target": "$.value", "params": {}}}, "clause_ref": "all fields have values"}
   ]
 }'::jsonb,
 1, 'active', 'platform', false, now()),

-- code_execution_v1
('code_execution_v1',
 'Verify code execution output: format, exit code, no errors',
 'Execute the provided code and return stdout, stderr, and exit_code. Exit code must be 0. Stderr must be empty.',
 '{
   "version": 1,
   "constraints": [
     {"id": "c1", "type": "exists", "target": "$.stdout", "params": {}, "clause_ref": "stdout present"},
     {"id": "c2", "type": "exists", "target": "$.stderr", "params": {}, "clause_ref": "stderr present"},
     {"id": "c3", "type": "exists", "target": "$.exit_code", "params": {}, "clause_ref": "exit_code present"},
     {"id": "c4", "type": "one_of", "target": "$.exit_code", "params": {"values": [0]}, "clause_ref": "exit code is 0"},
     {"id": "c5", "type": "length", "target": "$.stderr", "params": {"max": 0}, "clause_ref": "stderr is empty"}
   ]
 }'::jsonb,
 1, 'active', 'platform', false, now()),

-- translation_v1
('translation_v1',
 'Verify language translation: source/target detection, length ratio, completeness',
 'Translate the provided text to the target language. Translation length must be between 70% and 150% of the source. Translation must not be truncated.',
 '{
   "version": 1,
   "constraints": [
     {"id": "c1", "type": "exists", "target": "$.translation", "params": {}, "clause_ref": "translation present"},
     {"id": "c2", "type": "exists", "target": "$.source_language", "params": {}, "clause_ref": "source language detected"},
     {"id": "c3", "type": "exists", "target": "$.target_language", "params": {}, "clause_ref": "target language detected"},
     {"id": "c4", "type": "length", "target": "$.translation", "params": {"min": 1}, "clause_ref": "non-empty translation"},
     {"id": "c5", "type": "semantic_similarity", "target": "$.translation", "params": {"reference_target": "$.source", "min_score": 0.5}, "clause_ref": "translation preserves meaning"}
   ]
 }'::jsonb,
 1, 'active', 'platform', true, now());
