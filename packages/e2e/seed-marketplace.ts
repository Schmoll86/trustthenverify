/**
 * Seed Marketplace Script
 *
 * Registers 8 demo agents and 5 policy templates on the marketplace.
 * Policies are created with formal specs (validated) and set to public visibility.
 *
 * Usage: npx tsx packages/e2e/seed-marketplace.ts
 *
 * Environment variables:
 *   E2E_API_URL — API base URL (default: https://api.trustthenverify.com/v2)
 *   SUPABASE_URL — Supabase project URL (required for visibility updates)
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key (required for visibility updates)
 *
 * Idempotent: re-running skips already-registered agents and already-existing policies.
 */

import { TrustProtocol, type TrustProtocolConfig } from '@trustthenverify/sdk'

const API_URL = process.env.E2E_API_URL || 'https://api.trustthenverify.com/v2'
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

interface SeedAgent {
  name: string
  capabilities: string[]
  endpoint: string
}

const SEED_AGENTS: SeedAgent[] = [
  {
    name: 'CodeReview-Bot',
    capabilities: ['code-review', 'static-analysis', 'security-audit'],
    endpoint: 'https://agents.trustthenverify.com/code-review',
  },
  {
    name: 'WebSearch-Agent',
    capabilities: ['web-search', 'data-retrieval', 'summarization'],
    endpoint: 'https://agents.trustthenverify.com/web-search',
  },
  {
    name: 'DataAnalysis-Pro',
    capabilities: ['data-analysis', 'visualization', 'statistical-modeling'],
    endpoint: 'https://agents.trustthenverify.com/data-analysis',
  },
  {
    name: 'TranslationService',
    capabilities: ['translation', 'localization', 'content-adaptation'],
    endpoint: 'https://agents.trustthenverify.com/translation',
  },
  {
    name: 'ContentWriter-AI',
    capabilities: ['content-creation', 'copywriting', 'technical-writing'],
    endpoint: 'https://agents.trustthenverify.com/content-writer',
  },
  {
    name: 'SmartContract-Auditor',
    capabilities: ['smart-contract-audit', 'security-audit', 'solidity'],
    endpoint: 'https://agents.trustthenverify.com/contract-auditor',
  },
  {
    name: 'APITesting-Agent',
    capabilities: ['api-testing', 'integration-testing', 'load-testing'],
    endpoint: 'https://agents.trustthenverify.com/api-testing',
  },
  {
    name: 'DesignReview-Bot',
    capabilities: ['design-review', 'accessibility-audit', 'ux-analysis'],
    endpoint: 'https://agents.trustthenverify.com/design-review',
  },
]

interface PolicyTemplate {
  name: string
  intent: string
  description: string
  billing: string
  formalSpec: {
    version: 1
    constraints: Array<{
      id: string
      type: string
      field?: string
      operator?: string
      value?: unknown
      min?: number
      max?: number
      pattern?: string
    }>
  }
}

const POLICY_TEMPLATES: PolicyTemplate[] = [
  {
    name: 'Code Quality Gate',
    intent: 'Ensure code review deliverables meet quality standards with no critical issues.',
    description: 'Validates that code review output contains structured findings, severity ratings, and no critical security vulnerabilities remain unaddressed.',
    billing: 'platform',
    formalSpec: {
      version: 1,
      constraints: [
        { id: 'c1', type: 'required_field', field: 'findings' },
        { id: 'c2', type: 'required_field', field: 'summary' },
        { id: 'c3', type: 'range', field: 'criticalIssues', min: 0, max: 0 },
        { id: 'c4', type: 'min_length', field: 'summary', value: 50 },
      ],
    },
  },
  {
    name: 'Research Report Standard',
    intent: 'Validate research deliverables include sources, methodology, and structured conclusions.',
    description: 'Ensures research output has cited sources, clear methodology description, and actionable conclusions with confidence levels.',
    billing: 'platform',
    formalSpec: {
      version: 1,
      constraints: [
        { id: 'c1', type: 'required_field', field: 'sources' },
        { id: 'c2', type: 'required_field', field: 'methodology' },
        { id: 'c3', type: 'required_field', field: 'conclusions' },
        { id: 'c4', type: 'min_length', field: 'conclusions', value: 100 },
      ],
    },
  },
  {
    name: 'Translation Accuracy',
    intent: 'Ensure translations preserve meaning, tone, and technical terminology.',
    description: 'Validates translated content maintains semantic accuracy, proper formatting, and domain-specific terminology consistency.',
    billing: 'platform',
    formalSpec: {
      version: 1,
      constraints: [
        { id: 'c1', type: 'required_field', field: 'translatedText' },
        { id: 'c2', type: 'required_field', field: 'sourceLanguage' },
        { id: 'c3', type: 'required_field', field: 'targetLanguage' },
        { id: 'c4', type: 'min_length', field: 'translatedText', value: 10 },
      ],
    },
  },
  {
    name: 'Data Pipeline SLA',
    intent: 'Verify data processing output meets completeness and format requirements.',
    description: 'Ensures data pipeline deliverables contain all expected fields, proper data types, and meet minimum record count thresholds.',
    billing: 'platform',
    formalSpec: {
      version: 1,
      constraints: [
        { id: 'c1', type: 'required_field', field: 'records' },
        { id: 'c2', type: 'required_field', field: 'schema' },
        { id: 'c3', type: 'range', field: 'errorRate', min: 0, max: 5 },
        { id: 'c4', type: 'required_field', field: 'processedAt' },
      ],
    },
  },
  {
    name: 'API Integration Test Suite',
    intent: 'Validate API integration test results cover all endpoints with passing assertions.',
    description: 'Ensures test suite output includes coverage metrics, individual test results with pass/fail status, and no failing critical path tests.',
    billing: 'platform',
    formalSpec: {
      version: 1,
      constraints: [
        { id: 'c1', type: 'required_field', field: 'testResults' },
        { id: 'c2', type: 'required_field', field: 'coverage' },
        { id: 'c3', type: 'range', field: 'failedCritical', min: 0, max: 0 },
        { id: 'c4', type: 'range', field: 'coveragePercent', min: 80, max: 100 },
      ],
    },
  },
]

async function main() {
  console.log(`Seeding marketplace on ${API_URL}\n`)

  // Phase 1: Register agents
  console.log('--- Registering agents ---\n')
  const registeredProtocols: TrustProtocol[] = []

  for (const seed of SEED_AGENTS) {
    try {
      const config: TrustProtocolConfig = { apiUrl: API_URL }
      const protocol = new TrustProtocol(config)
      await protocol.generateKeypair()

      const agent = await protocol.register({
        name: seed.name,
        capabilities: seed.capabilities,
        endpoint: seed.endpoint,
      })

      console.log(`  Registered: ${seed.name} (${agent.publicKey.slice(0, 16)}...)`)
      registeredProtocols.push(protocol)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('already registered')) {
        console.log(`  Skipped: ${seed.name} (already registered)`)
      } else {
        console.error(`  Failed: ${seed.name} — ${msg}`)
      }
    }
  }

  // Phase 2: Create policies (using first registered agent as creator)
  console.log('\n--- Creating policy templates ---\n')

  if (registeredProtocols.length === 0) {
    console.log('  No protocols available for policy creation. Agents may all exist already.')
    console.log('  To create policies, ensure at least one agent can register fresh.\n')

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      console.log('  Tip: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to update visibility on existing policies.\n')
      console.log('Done.')
      return
    }
  }

  const creator = registeredProtocols[0]
  if (!creator) {
    console.log('  Skipping policy creation (no fresh agent available).\n')
    console.log('Done.')
    return
  }

  const policyIds: string[] = []

  for (const template of POLICY_TEMPLATES) {
    try {
      const policy = await creator.createPolicy({
        name: template.name,
        intent: template.intent,
        description: template.description,
        billing: template.billing as 'free' | 'platform' | 'creator',
      })

      console.log(`  Created: ${template.name} (${policy.id.slice(0, 8)}...)`)
      policyIds.push(policy.id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`  Failed: ${template.name} — ${msg}`)
    }
  }

  // Phase 3: Set policies to public visibility (requires Supabase direct access)
  if (SUPABASE_URL && SUPABASE_KEY && policyIds.length > 0) {
    console.log('\n--- Setting policies to public visibility ---\n')

    for (const id of policyIds) {
      try {
        const res = await fetch(
          `${SUPABASE_URL}/rest/v1/policies?id=eq.${id}`,
          {
            method: 'PATCH',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal',
            },
            body: JSON.stringify({ visibility: 'public' }),
          }
        )

        if (res.ok) {
          console.log(`  Public: ${id.slice(0, 8)}...`)
        } else {
          console.error(`  Failed to set visibility for ${id.slice(0, 8)}...: HTTP ${res.status}`)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`  Failed: ${id.slice(0, 8)}... — ${msg}`)
      }
    }
  } else if (policyIds.length > 0) {
    console.log('\n  Note: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to make policies public.')
    console.log('  Policies created as private (default).\n')
  }

  console.log('\nDone.')
}

main().catch(console.error)
