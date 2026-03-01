/**
 * Seed Agent Registration Script
 *
 * Registers 5 seed agents on the sandbox environment so the marketplace
 * appears active for new users. Each agent has a unique name, capabilities,
 * and endpoint URL.
 *
 * Usage: npx tsx packages/e2e/seed-agents.ts
 *
 * Agents are generated deterministically from fixed seeds so re-running
 * is idempotent (registration will fail with "already registered" for
 * existing agents — that's expected).
 */

import { TrustProtocol, type TrustProtocolConfig } from '@trustthenverify/sdk'

const API_URL = process.env.E2E_API_URL || 'https://sandbox.trustthenverify.com/v2'

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
]

async function main() {
  console.log(`Seeding agents on ${API_URL}\n`)

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

      console.log(`  Registered: ${seed.name}`)
      console.log(`    pubkey: ${agent.publicKey.slice(0, 16)}...`)
      console.log(`    capabilities: ${seed.capabilities.join(', ')}`)
      console.log()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('already registered')) {
        console.log(`  Skipped: ${seed.name} (already registered)`)
      } else {
        console.error(`  Failed: ${seed.name} — ${msg}`)
      }
      console.log()
    }
  }

  console.log('Done.')
}

main().catch(console.error)
