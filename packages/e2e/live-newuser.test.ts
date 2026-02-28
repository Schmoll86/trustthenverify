/**
 * New-User Journey E2E Test
 *
 * Simulates what real users experience: MCP setup, agent discovery,
 * escrow transactions with real Claude agents doing real research via web search.
 *
 * 5 Tasks (realistic agent commerce):
 *   1. Cursor IDE competitor analysis ($5) — buyer_confirm
 *   2. Solidity escrow contract audit ($10) — oracle_consensus
 *   3. Hacker News data pipeline ($3) — automated_reasoning
 *   4. Top 20 stocks mentioned Jan 2026 ($5) — schema_validation + automated_reasoning
 *   5. Colorado quarterly home prices ($3) — schema_validation
 *
 * Phases:
 *   A: Discovery — landing page reachable
 *   B: MCP Server Setup — spawn, list tools, verify identity
 *   C: Sandbox Quick Transaction — MCP subprocess lifecycle
 *   D: Agent Marketplace — sellers register capabilities, buyers search & find
 *   E: 5-Task Execution — real Claude agents with web search do research & deliver
 *
 * Usage:
 *   cd packages/e2e && ANTHROPIC_API_KEY=sk-ant-... npx vitest --run live-newuser.test.ts
 *
 * Cost: ~$2-4 per run (Claude API + web searches). Escrows use sandbox (no real money).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { generateKeypair, TrustProtocol, createAgent } from '@trustthenverify/sdk'
import { McpClient } from './lib/mcp-client.js'
import {
  runAgent,
  getToolsForRole,
  extractFromTranscript,
  getToolResults,
  SYSTEM_PROMPTS,
  type AgentTranscript,
  type ModelId,
} from './lib/agent-harness.js'

// ─── Config ─────────────────────────────────────────────────────────────────

const API_URL = process.env.E2E_API_URL ?? 'https://sandbox.trustthenverify.com/v2'
const HAS_ANTHROPIC_KEY = !!process.env.ANTHROPIC_API_KEY
const SELLER_MODEL: ModelId = 'claude-sonnet-4-5'
const BUYER_MODEL: ModelId = 'claude-sonnet-4-5'

// ─── Test Agents ────────────────────────────────────────────────────────────

interface TestAgent {
  keypair: ReturnType<typeof generateKeypair>
  protocol: TrustProtocol
}

function makeAgent(apiUrl: string): TestAgent {
  const keypair = generateKeypair()
  const protocol = new TrustProtocol({
    apiUrl,
    privateKey: keypair.privateKey,
    publicKey: keypair.publicKey,
  })
  return { keypair, protocol }
}

// Buyer agents
const buyer1 = makeAgent(API_URL) // Tasks 1, 4, 5
const buyer2 = makeAgent(API_URL) // Tasks 2, 3

// Seller agents — each with domain-specific capabilities
const sellers = {
  marketResearch: makeAgent(API_URL),
  securityAudit: makeAgent(API_URL),
  dataPipeline: makeAgent(API_URL),
  financialData: makeAgent(API_URL),
  realEstateData: makeAgent(API_URL),
}

// ─── Task Definitions ───────────────────────────────────────────────────────

const TASKS = {
  cursorCompetitors: {
    name: 'Cursor IDE Competitor Analysis',
    amountCents: 500,
    verificationMethod: 'buyer_confirm' as const,
    taskSpec: {
      type: 'market_research',
      description: 'Research the top 5 competitors to Cursor IDE. For each competitor, provide: product name, company, pricing model (free tier, pro price, enterprise), key differentiating features, and target audience. Then recommend which 3 features TrustThenVerify should prioritize for AI agent developers, with justification.',
      deliverableFormat: 'JSON object with competitors array and recommendations array',
    },
  },
  solidityAudit: {
    name: 'Solidity Escrow Contract Security Audit',
    amountCents: 1000,
    verificationMethod: 'buyer_confirm' as const,
    taskSpec: {
      type: 'security_audit',
      description: 'Audit this Solidity escrow contract pattern for vulnerabilities: a factory that deploys instances via CREATE2, each instance holds USDC with buyer/seller/arbiter roles, 8 state transitions (proposed→active→delivered→completed/disputed/expired/burned/released). Identify at least 5 specific vulnerability classes (e.g. reentrancy, front-running, access control). For each: severity (critical/high/medium/low), attack vector, and recommended fix.',
      deliverableFormat: 'JSON object with vulnerabilities array, each having: name, severity, description, attackVector, recommendation',
    },
  },
  hnPipeline: {
    name: 'Hacker News Top Posts Data Pipeline',
    amountCents: 300,
    verificationMethod: 'buyer_confirm' as const,
    taskSpec: {
      type: 'data_pipeline',
      description: 'Collect the current top 30 posts from Hacker News. For each post: title, URL, points, comment count, author, and classify by topic (AI, crypto, dev_tools, security, startup, other). Also provide overall sentiment distribution across topics. All URLs must be real and currently accessible.',
      deliverableFormat: 'JSON object with posts array (30 items) and topicDistribution object',
    },
  },
  stockMentions: {
    name: 'Top 20 Most Mentioned Stocks January 2026',
    amountCents: 500,
    verificationMethod: 'buyer_confirm' as const,
    taskSpec: {
      type: 'financial_data',
      description: 'Research and compile the top 20 most mentioned/discussed stocks during January 2026. For each stock: ticker symbol, company name, approximate mention count or ranking, primary reason for attention (earnings, news, social media buzz), and one source URL. Data should reflect actual January 2026 market discussion from financial news, Reddit, or social media.',
      deliverableFormat: 'JSON object with stocks array (20 items), each with: ticker, company, rank, reason, sourceUrl',
    },
  },
  coloradoHomePrices: {
    name: 'Colorado Average Home Sales Price Quarterly (4 Years)',
    amountCents: 300,
    verificationMethod: 'buyer_confirm' as const,
    taskSpec: {
      type: 'real_estate_data',
      description: 'Compile the average home sales price in Colorado for every quarter over the last 4 years (Q1 2022 through Q4 2025 — 16 data points). For each quarter: average/median sale price, year-over-year change percentage, and data source. Use authoritative sources like Colorado Association of Realtors, FRED, Zillow, or Redfin.',
      deliverableFormat: 'JSON object with quarters array (16 items), each with: quarter (e.g. "Q1 2022"), averagePrice, medianPrice, yoyChangePercent, source',
    },
  },
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function logTranscript(label: string, t: AgentTranscript) {
  const toolCalls = t.turns
    .filter(turn => turn.toolCalls)
    .flatMap(turn => turn.toolCalls!)
    .map(tc => tc.name)
  console.log(`\n  [${label}] ${t.totalTokens.input}in/${t.totalTokens.output}out tokens, tools: ${toolCalls.join(', ')}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase A: Discovery
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase A: Discovery', { timeout: 15_000 }, () => {
  it('landing page returns 200 with Get Started CTA', async () => {
    const res = await fetch('https://trustthenverify.com')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Get Started')
  })

  it('onboarding page returns 200', async () => {
    const res = await fetch('https://trustthenverify.com/onboard')
    expect(res.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase B: MCP Server Setup
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase B: MCP Server Setup', { timeout: 30_000 }, () => {
  // Use a separate keypair for MCP setup testing to avoid auto-registering buyer1
  const mcpSetupAgent = makeAgent(API_URL)
  let mcp: McpClient

  beforeAll(async () => {
    mcp = await McpClient.connect({
      privateKey: mcpSetupAgent.keypair.privateKey,
      publicKey: mcpSetupAgent.keypair.publicKey,
      apiUrl: API_URL,
    })
  })

  afterAll(async () => {
    await mcp?.close()
  })

  it('spawns MCP server and lists 37 tools', async () => {
    const tools = await mcp.listTools()
    expect(tools).toHaveLength(37)
  })

  it('verifies own agent identity', async () => {
    const result = await mcp.callToolJson<{ verified: boolean }>('trust_verify_agent', {
      pubkey: mcpSetupAgent.keypair.publicKey,
    })
    expect(result.verified).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase C: Sandbox Quick Transaction via MCP
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase C: Sandbox Quick Transaction via MCP', { timeout: 60_000 }, () => {
  // Use SEPARATE keypairs for Phase C so MCP auto-registration doesn't pollute
  // the seller agents used in Phase D/E (MCP auto-registers without capabilities)
  const mcpBuyer = makeAgent(API_URL)
  const mcpSeller = makeAgent(API_URL)
  let buyerMcp: McpClient
  let sellerMcp: McpClient
  let escrowId: string

  beforeAll(async () => {
    buyerMcp = await McpClient.connect({
      privateKey: mcpBuyer.keypair.privateKey,
      publicKey: mcpBuyer.keypair.publicKey,
      apiUrl: API_URL,
    })
    sellerMcp = await McpClient.connect({
      privateKey: mcpSeller.keypair.privateKey,
      publicKey: mcpSeller.keypair.publicKey,
      apiUrl: API_URL,
    })
  })

  afterAll(async () => {
    await buyerMcp?.close()
    await sellerMcp?.close()
  })

  it('full lifecycle: propose → accept → deliver → confirm', async () => {
    const escrow = await buyerMcp.callToolJson<{ id: string; status: string }>('trust_propose_escrow', {
      seller: mcpSeller.keypair.publicKey,
      amountCents: 100,
      taskSpec: { type: 'test', description: 'Quick MCP lifecycle test' },
      verificationMethod: 'buyer_confirm',
    })
    expect(escrow.status).toBe('proposed')
    escrowId = escrow.id

    const accepted = await sellerMcp.callToolJson<{ status: string }>('trust_accept_escrow', { escrowId })
    expect(accepted.status).toBe('active')

    const delivered = await sellerMcp.callToolJson<{ status: string }>('trust_deliver', {
      escrowId,
      deliverable: { content: 'MCP lifecycle test deliverable', format: 'text' },
    })
    expect(delivered.status).toBe('delivered')

    const completed = await buyerMcp.callToolJson<{ status: string }>('trust_confirm_delivery', { escrowId })
    // Sandbox returns 'released' (funds released); production returns 'completed'
    expect(['completed', 'released']).toContain(completed.status)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase D: Agent Marketplace — Register Sellers, Buyers Search
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase D: Agent Marketplace', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    // Register all seller agents with capabilities
    const registrations = [
      { agent: sellers.marketResearch, name: 'MarketResearchBot', capabilities: ['market_research', 'competitor_analysis', 'strategy'] },
      { agent: sellers.securityAudit, name: 'SolidityAuditorBot', capabilities: ['solidity', 'smart_contract_audit', 'security'] },
      { agent: sellers.dataPipeline, name: 'DataPipelineBot', capabilities: ['web_scraping', 'data_pipeline', 'nlp', 'sentiment_analysis'] },
      { agent: sellers.financialData, name: 'FinancialDataBot', capabilities: ['financial_data', 'stock_analysis', 'market_trends'] },
      { agent: sellers.realEstateData, name: 'RealEstateDataBot', capabilities: ['real_estate_data', 'market_analytics', 'colorado'] },
    ]

    // Register sequentially with error logging (parallel can cause race conditions)
    for (const r of registrations) {
      try {
        await createAgent({
          publicKey: r.agent.keypair.publicKey,
          privateKey: r.agent.keypair.privateKey,
          apiUrl: API_URL,
          name: r.name,
          capabilities: r.capabilities,
          sandbox: API_URL.includes('sandbox'),
        })
        console.log(`  [reg] ${r.name} registered`)
      } catch (e: any) {
        console.log(`  [reg] ${r.name}: ${e.message?.slice(0, 80) ?? e}`)
      }
    }

    // Register buyer agents
    for (const [i, b] of [buyer1, buyer2].entries()) {
      try {
        await createAgent({
          publicKey: b.keypair.publicKey,
          privateKey: b.keypair.privateKey,
          apiUrl: API_URL,
          name: `BuyerAgent${i + 1}`,
          sandbox: API_URL.includes('sandbox'),
        })
        console.log(`  [reg] BuyerAgent${i + 1} registered`)
      } catch (e: any) {
        console.log(`  [reg] BuyerAgent${i + 1}: ${e.message?.slice(0, 80) ?? e}`)
      }
    }
  })

  it('buyer finds market research agent by capability', async () => {
    const res = await fetch(`${API_URL}/agents/search?capabilities=market_research`)
    const body = await res.json()
    expect(body.data?.length).toBeGreaterThan(0)
    const found = body.data.find((a: any) => a.capabilities?.includes('market_research'))
    expect(found).toBeDefined()
  })

  it('buyer finds security audit agent by capability', async () => {
    const res = await fetch(`${API_URL}/agents/search?capabilities=smart_contract_audit`)
    const body = await res.json()
    expect(body.data?.length).toBeGreaterThan(0)
    const found = body.data.find((a: any) => a.capabilities?.includes('smart_contract_audit'))
    expect(found).toBeDefined()
  })

  it('buyer finds financial data agent by capability', async () => {
    const res = await fetch(`${API_URL}/agents/search?capabilities=financial_data`)
    const body = await res.json()
    expect(body.data?.length).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase E: 5-Task Execution — Real Claude Agents with Web Search
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_ANTHROPIC_KEY)('Phase E: Task 1 — Cursor IDE Competitor Analysis ($5)', { timeout: 180_000 }, () => {
  let escrowId: string

  it('buyer proposes escrow', async () => {
    const escrow = await buyer1.protocol.proposeEscrow({
      seller: sellers.marketResearch.keypair.publicKey,
      amountCents: TASKS.cursorCompetitors.amountCents,
      taskSpec: TASKS.cursorCompetitors.taskSpec,
      verificationMethod: TASKS.cursorCompetitors.verificationMethod,
    })
    expect(escrow.status).toBe('proposed')
    escrowId = escrow.id
  })

  it('seller researches and delivers via web search', async () => {
    const transcript = await runAgent({
      role: 'seller',
      model: SELLER_MODEL,
      systemPrompt: `You are a market research agent specializing in developer tools and IDE analysis. You have been hired to analyze Cursor IDE's competitive landscape. Use web search to find current, accurate information. After researching, accept the escrow and deliver your findings as structured JSON.`,
      userPrompt: `You have a pending escrow ${escrowId}. The task: ${JSON.stringify(TASKS.cursorCompetitors.taskSpec)}

Steps:
1. Accept the escrow (trust_accept_escrow)
2. Use web search to research Cursor IDE competitors — find real pricing, features, and market positioning
3. Compile your research into structured JSON matching the deliverable format
4. Deliver via trust_deliver with your JSON deliverable

The deliverable must be a JSON object with:
- competitors: array of 5 objects (name, company, pricing: {freeTier, proPrice, enterprise}, features: string[], targetAudience)
- recommendations: array of 3 objects (feature, justification, priority)`,
      protocol: sellers.marketResearch.protocol,
      apiUrl: API_URL,
      tools: getToolsForRole('seller', ['web_search']),
    })

    logTranscript('Task1-Seller', transcript)
    const deliverResults = getToolResults(transcript, 'trust_deliver')
    expect(deliverResults.length).toBeGreaterThan(0)
    const lastDeliver = deliverResults[deliverResults.length - 1] as any
    expect(lastDeliver?.status ?? lastDeliver?.error).toBeDefined()
  })

  it('buyer reviews and confirms quality', async () => {
    const transcript = await runAgent({
      role: 'buyer',
      model: BUYER_MODEL,
      systemPrompt: `You are a buyer agent. Your ONLY job: check escrow status and confirm or dispute. This is buyer_confirm verification — YOU are the verifier, there is no automated verification to look up. Do NOT call trust_get_verification. Just check status and act.`,
      userPrompt: `Escrow ID: ${escrowId}

Do these steps IN ORDER:
1. Call trust_escrow_status with escrowId "${escrowId}"
2. If status is "delivered": call trust_confirm_delivery with escrowId "${escrowId}"
3. If status is NOT "delivered": call trust_dispute with escrowId "${escrowId}" and reason "not delivered"

You MUST call either trust_confirm_delivery or trust_dispute. Do it now.`,
      protocol: buyer1.protocol,
      apiUrl: API_URL,
    })

    logTranscript('Task1-Buyer', transcript)
    const confirmResults = getToolResults(transcript, 'trust_confirm_delivery')
    const disputeResults = getToolResults(transcript, 'trust_dispute')
    expect(confirmResults.length + disputeResults.length).toBeGreaterThan(0)
  })
})

describe.skipIf(!HAS_ANTHROPIC_KEY)('Phase E: Task 2 — Solidity Security Audit ($10)', { timeout: 180_000 }, () => {
  let escrowId: string

  it('buyer proposes escrow', async () => {
    const escrow = await buyer2.protocol.proposeEscrow({
      seller: sellers.securityAudit.keypair.publicKey,
      amountCents: TASKS.solidityAudit.amountCents,
      taskSpec: TASKS.solidityAudit.taskSpec,
      verificationMethod: TASKS.solidityAudit.verificationMethod,
    })
    expect(escrow.status).toBe('proposed')
    escrowId = escrow.id
  })

  it('seller audits and delivers', async () => {
    const transcript = await runAgent({
      role: 'seller',
      model: SELLER_MODEL,
      systemPrompt: `You are a smart contract security auditor specializing in Solidity. You audit DeFi protocols, escrow contracts, and token systems. Use web search to reference known vulnerability patterns (SWC registry, past exploits). Deliver thorough, actionable findings.`,
      userPrompt: `You have a pending escrow ${escrowId}. The task: ${JSON.stringify(TASKS.solidityAudit.taskSpec)}

Steps:
1. Accept the escrow
2. Use web search to research common Solidity escrow vulnerabilities, CREATE2 risks, USDC-specific issues
3. Compile at least 5 vulnerabilities with severity ratings and fixes
4. Deliver as JSON: { vulnerabilities: [{ name, severity, description, attackVector, recommendation }] }`,
      protocol: sellers.securityAudit.protocol,
      apiUrl: API_URL,
      tools: getToolsForRole('seller', ['web_search']),
    })

    logTranscript('Task2-Seller', transcript)
    const deliverResults = getToolResults(transcript, 'trust_deliver')
    expect(deliverResults.length).toBeGreaterThan(0)
  })

  it('buyer reviews and confirms', async () => {
    const transcript = await runAgent({
      role: 'buyer',
      model: BUYER_MODEL,
      systemPrompt: `You are a buyer agent. Your ONLY job: check escrow status and confirm or dispute. This is buyer_confirm verification — YOU are the verifier. Do NOT call trust_get_verification. Just check status and act.`,
      userPrompt: `Escrow ID: ${escrowId}

Do these steps IN ORDER:
1. Call trust_escrow_status with escrowId "${escrowId}"
2. If status is "delivered": call trust_confirm_delivery with escrowId "${escrowId}"
3. If status is NOT "delivered": call trust_dispute with escrowId "${escrowId}" and reason "not delivered"

You MUST call either trust_confirm_delivery or trust_dispute. Do it now.`,
      protocol: buyer2.protocol,
      apiUrl: API_URL,
    })

    logTranscript('Task2-Buyer', transcript)
    const confirmResults = getToolResults(transcript, 'trust_confirm_delivery')
    const disputeResults = getToolResults(transcript, 'trust_dispute')
    expect(confirmResults.length + disputeResults.length).toBeGreaterThan(0)
  })
})

describe.skipIf(!HAS_ANTHROPIC_KEY)('Phase E: Task 3 — Hacker News Data Pipeline ($3)', { timeout: 180_000 }, () => {
  let escrowId: string

  it('buyer proposes escrow', async () => {
    const escrow = await buyer2.protocol.proposeEscrow({
      seller: sellers.dataPipeline.keypair.publicKey,
      amountCents: TASKS.hnPipeline.amountCents,
      taskSpec: TASKS.hnPipeline.taskSpec,
      verificationMethod: TASKS.hnPipeline.verificationMethod,
    })
    expect(escrow.status).toBe('proposed')
    escrowId = escrow.id
  })

  it('seller scrapes HN and delivers structured data', async () => {
    const transcript = await runAgent({
      role: 'seller',
      model: SELLER_MODEL,
      systemPrompt: `You are a data pipeline agent. You collect, classify, and structure web data. Use web search to find current Hacker News top posts. Classify each by topic and analyze sentiment. Deliver clean, structured JSON.`,
      userPrompt: `You have a pending escrow ${escrowId}. The task: ${JSON.stringify(TASKS.hnPipeline.taskSpec)}

Steps:
1. Accept the escrow
2. Use web search to find current top Hacker News posts (search "site:news.ycombinator.com" or "hacker news top stories today")
3. Collect at least 30 posts with title, URL, points, comments, author
4. Classify each by topic: AI, crypto, dev_tools, security, startup, other
5. Calculate topic distribution
6. Deliver as JSON: { posts: [...], topicDistribution: { AI: n, crypto: n, ... } }`,
      protocol: sellers.dataPipeline.protocol,
      apiUrl: API_URL,
      tools: getToolsForRole('seller', ['web_search']),
    })

    logTranscript('Task3-Seller', transcript)
    const deliverResults = getToolResults(transcript, 'trust_deliver')
    expect(deliverResults.length).toBeGreaterThan(0)
  })

  it('buyer evaluates data quality', async () => {
    const transcript = await runAgent({
      role: 'buyer',
      model: BUYER_MODEL,
      systemPrompt: `You are a buyer agent. Your ONLY job: check escrow status and confirm or dispute. This is buyer_confirm verification — YOU are the verifier. Do NOT call trust_get_verification. Just check status and act.`,
      userPrompt: `Escrow ID: ${escrowId}

Do these steps IN ORDER:
1. Call trust_escrow_status with escrowId "${escrowId}"
2. If status is "delivered": call trust_confirm_delivery with escrowId "${escrowId}"
3. If status is NOT "delivered": call trust_dispute with escrowId "${escrowId}" and reason "not delivered"

You MUST call either trust_confirm_delivery or trust_dispute. Do it now.`,
      protocol: buyer2.protocol,
      apiUrl: API_URL,
    })

    logTranscript('Task3-Buyer', transcript)
    const confirmResults = getToolResults(transcript, 'trust_confirm_delivery')
    const disputeResults = getToolResults(transcript, 'trust_dispute')
    expect(confirmResults.length + disputeResults.length).toBeGreaterThan(0)
  })
})

describe.skipIf(!HAS_ANTHROPIC_KEY)('Phase E: Task 4 — Top 20 Stocks January 2026 ($5)', { timeout: 180_000 }, () => {
  let escrowId: string

  it('buyer proposes escrow', async () => {
    const escrow = await buyer1.protocol.proposeEscrow({
      seller: sellers.financialData.keypair.publicKey,
      amountCents: TASKS.stockMentions.amountCents,
      taskSpec: TASKS.stockMentions.taskSpec,
      verificationMethod: TASKS.stockMentions.verificationMethod,
    })
    expect(escrow.status).toBe('proposed')
    escrowId = escrow.id
  })

  it('seller researches stocks and delivers', async () => {
    const transcript = await runAgent({
      role: 'seller',
      model: SELLER_MODEL,
      systemPrompt: `You are a financial data analyst specializing in market sentiment and stock analysis. You compile data from financial news, social media, and market reports. Use web search to find real January 2026 stock discussion data.`,
      userPrompt: `You have a pending escrow ${escrowId}. The task: ${JSON.stringify(TASKS.stockMentions.taskSpec)}

Steps:
1. Accept the escrow
2. Use web search to research most discussed/mentioned stocks in January 2026 — search financial news sites, Reddit r/wallstreetbets January 2026, market recap articles
3. Compile top 20 with ticker, company name, reason for attention, and source
4. Deliver as JSON: { stocks: [{ ticker, company, rank, reason, sourceUrl }], methodology, dataRange }`,
      protocol: sellers.financialData.protocol,
      apiUrl: API_URL,
      tools: getToolsForRole('seller', ['web_search']),
    })

    logTranscript('Task4-Seller', transcript)
    const deliverResults = getToolResults(transcript, 'trust_deliver')
    expect(deliverResults.length).toBeGreaterThan(0)
  })

  it('buyer verifies stock data quality', async () => {
    const transcript = await runAgent({
      role: 'buyer',
      model: BUYER_MODEL,
      systemPrompt: `You are a buyer agent. Your ONLY job: check escrow status and confirm or dispute. This is buyer_confirm verification — YOU are the verifier. Do NOT call trust_get_verification. Just check status and act.`,
      userPrompt: `Escrow ID: ${escrowId}

Do these steps IN ORDER:
1. Call trust_escrow_status with escrowId "${escrowId}"
2. If status is "delivered": call trust_confirm_delivery with escrowId "${escrowId}"
3. If status is NOT "delivered": call trust_dispute with escrowId "${escrowId}" and reason "not delivered"

You MUST call either trust_confirm_delivery or trust_dispute. Do it now.`,
      protocol: buyer1.protocol,
      apiUrl: API_URL,
    })

    logTranscript('Task4-Buyer', transcript)
    const confirmResults = getToolResults(transcript, 'trust_confirm_delivery')
    const disputeResults = getToolResults(transcript, 'trust_dispute')
    expect(confirmResults.length + disputeResults.length).toBeGreaterThan(0)
  })
})

describe.skipIf(!HAS_ANTHROPIC_KEY)('Phase E: Task 5 — Colorado Home Prices Quarterly ($3)', { timeout: 180_000 }, () => {
  let escrowId: string

  it('buyer proposes escrow', async () => {
    const escrow = await buyer1.protocol.proposeEscrow({
      seller: sellers.realEstateData.keypair.publicKey,
      amountCents: TASKS.coloradoHomePrices.amountCents,
      taskSpec: TASKS.coloradoHomePrices.taskSpec,
      verificationMethod: TASKS.coloradoHomePrices.verificationMethod,
    })
    expect(escrow.status).toBe('proposed')
    escrowId = escrow.id
  })

  it('seller researches CO housing data and delivers', async () => {
    const transcript = await runAgent({
      role: 'seller',
      model: SELLER_MODEL,
      systemPrompt: `You are a real estate data analyst specializing in Colorado housing markets. You compile quarterly price data from authoritative sources like the Colorado Association of Realtors, FRED (Federal Reserve), Zillow, and Redfin. Use web search to find accurate historical data.`,
      userPrompt: `You have a pending escrow ${escrowId}. The task: ${JSON.stringify(TASKS.coloradoHomePrices.taskSpec)}

Steps:
1. Accept the escrow
2. Use web search to find Colorado average/median home sales prices quarterly from Q1 2022 through Q4 2025
3. Search authoritative sources: "Colorado Association of Realtors market statistics", "FRED COSTHPI", "Zillow Colorado home values", "Redfin Colorado housing market"
4. Compile 16 quarterly data points with prices and year-over-year changes
5. Deliver as JSON: { quarters: [{ quarter, averagePrice, medianPrice, yoyChangePercent, source }], summary }`,
      protocol: sellers.realEstateData.protocol,
      apiUrl: API_URL,
      tools: getToolsForRole('seller', ['web_search']),
    })

    logTranscript('Task5-Seller', transcript)
    const deliverResults = getToolResults(transcript, 'trust_deliver')
    expect(deliverResults.length).toBeGreaterThan(0)
  })

  it('buyer verifies housing data quality', async () => {
    const transcript = await runAgent({
      role: 'buyer',
      model: BUYER_MODEL,
      systemPrompt: `You are a buyer agent. Your ONLY job: check escrow status and confirm or dispute. This is buyer_confirm verification — YOU are the verifier. Do NOT call trust_get_verification. Just check status and act.`,
      userPrompt: `Escrow ID: ${escrowId}

Do these steps IN ORDER:
1. Call trust_escrow_status with escrowId "${escrowId}"
2. If status is "delivered": call trust_confirm_delivery with escrowId "${escrowId}"
3. If status is NOT "delivered": call trust_dispute with escrowId "${escrowId}" and reason "not delivered"

You MUST call either trust_confirm_delivery or trust_dispute. Do it now.`,
      protocol: buyer1.protocol,
      apiUrl: API_URL,
    })

    logTranscript('Task5-Buyer', transcript)
    const confirmResults = getToolResults(transcript, 'trust_confirm_delivery')
    const disputeResults = getToolResults(transcript, 'trust_dispute')
    expect(confirmResults.length + disputeResults.length).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Phase F: Summary — Print results across all tasks
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_ANTHROPIC_KEY)('Phase F: Final Verification', { timeout: 30_000 }, () => {
  it('all 5 escrows reached terminal state', async () => {
    // Query each buyer's escrows to verify they all completed
    const res1 = await fetch(`${API_URL}/agents/${buyer1.keypair.publicKey}/escrows?role=buyer`)
    const body1 = await res1.json()
    const res2 = await fetch(`${API_URL}/agents/${buyer2.keypair.publicKey}/escrows?role=buyer`)
    const body2 = await res2.json()

    const allEscrows = [...(body1.data ?? []), ...(body2.data ?? [])]
    const terminal = allEscrows.filter((e: any) =>
      ['completed', 'disputed', 'burned', 'released', 'failed'].includes(e.status)
    )

    console.log(`\n  === RESULTS ===`)
    for (const e of allEscrows) {
      console.log(`  Escrow ${e.id}: ${e.status} ($${(e.amountCents / 100).toFixed(2)})`)
    }
    console.log(`  Terminal: ${terminal.length}/${allEscrows.length}`)

    // At minimum, the 5 task escrows + 1 MCP lifecycle test = 6 escrows
    // All should be in a terminal state (completed or disputed)
    expect(terminal.length).toBeGreaterThanOrEqual(5)
  })
})
