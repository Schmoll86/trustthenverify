import { describe, it, expect, beforeAll, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { TrustProtocol } from '@trustthenverify/sdk'
import { createServer } from '../server.js'

// ---------------------------------------------------------------------------
// Mock TrustProtocol — every method returns a stub so we can test MCP wiring
// ---------------------------------------------------------------------------
function mockProtocol(): TrustProtocol {
  const proto = Object.create(TrustProtocol.prototype)
  const methods = [
    'verify', 'spawnAgent', 'suggestCollateral',
    'proposeEscrow', 'getEscrow', 'acceptEscrow', 'fundEscrow',
    'deliver', 'confirmDelivery', 'getVerification',
    'disputeEscrow', 'fileForArbitration', 'getDispute', 'submitRuling',
    'createPolicy', 'getCoverage', 'revisePolicy', 'activatePolicy',
    'refinePolicy', 'refinementStatus',
    'publishAttestation', 'useMarketplacePolicy',
    'joinOraclePool', 'withdrawFromOraclePool', 'getOracleStatus',
    'getOracleAssignments', 'submitOracleVote', 'getOracleEarnings', 'getOracleTask',
    'setupStripeCustomer', 'createSetupIntent', 'attachPaymentMethod',
    'setupStripeConnect', 'getStripeStatus',
  ] as const
  for (const m of methods) {
    proto[m] = vi.fn().mockResolvedValue({ mock: m })
  }
  return proto as TrustProtocol
}

// ---------------------------------------------------------------------------
// Expected tool names (37 total)
// ---------------------------------------------------------------------------
const EXPECTED_TOOLS = [
  'trust_search_agents',
  'trust_verify_agent',
  'trust_suggest_collateral',
  'trust_spawn_agent',
  'trust_propose_escrow',
  'trust_accept_escrow',
  'trust_fund_escrow',
  'trust_escrow_status',
  'trust_deliver',
  'trust_confirm_delivery',
  'trust_get_verification',
  'trust_dispute',
  'trust_file_arbitration',
  'trust_get_dispute',
  'trust_submit_ruling',
  'trust_create_policy',
  'trust_get_coverage',
  'trust_revise_policy',
  'trust_activate_policy',
  'trust_refine_policy',
  'trust_refinement_status',
  'trust_list_marketplace',
  'trust_use_marketplace_policy',
  'trust_query_attestations',
  'trust_publish_attestation',
  'trust_join_oracle_pool',
  'trust_withdraw_oracle_pool',
  'trust_oracle_status',
  'trust_oracle_assignments',
  'trust_submit_oracle_vote',
  'trust_oracle_earnings',
  'trust_get_oracle_task',
  'trust_setup_stripe_customer',
  'trust_create_setup_intent',
  'trust_attach_payment_method',
  'trust_setup_stripe_connect',
  'trust_get_stripe_status',
]

// ---------------------------------------------------------------------------
// Setup: connect MCP server ↔ client via in-memory transport
// ---------------------------------------------------------------------------
let client: Client
let proto: TrustProtocol

beforeAll(async () => {
  proto = mockProtocol()
  const mcpServer = createServer(proto, 'http://localhost:8787')

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  client = new Client({ name: 'test-client', version: '0.0.1' })

  await Promise.all([
    client.connect(clientTransport),
    mcpServer.connect(serverTransport),
  ])
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP tool registration', () => {
  it('registers exactly 37 tools', async () => {
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(37)
  })

  it('registers all expected tool names', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual([...EXPECTED_TOOLS].sort())
  })

  it('every tool has a non-empty description', async () => {
    const { tools } = await client.listTools()
    for (const tool of tools) {
      expect(tool.description, `${tool.name} missing description`).toBeTruthy()
    }
  })

  it('every tool has an inputSchema', async () => {
    const { tools } = await client.listTools()
    for (const tool of tools) {
      expect(tool.inputSchema, `${tool.name} missing inputSchema`).toBeDefined()
      expect(tool.inputSchema.type).toBe('object')
    }
  })
})

describe('tool invocation', () => {
  it('trust_verify_agent calls protocol.verify and returns JSON', async () => {
    const result = await client.callTool({
      name: 'trust_verify_agent',
      arguments: { pubkey: 'abc123' },
    })
    expect(result.isError).toBeFalsy()
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0].type).toBe('text')
    const parsed = JSON.parse(content[0].text)
    expect(parsed).toEqual({ mock: 'verify' })
    expect((proto as any).verify).toHaveBeenCalledWith('abc123')
  })

  it('trust_escrow_status calls protocol.getEscrow', async () => {
    const result = await client.callTool({
      name: 'trust_escrow_status',
      arguments: { escrowId: 'esc-1' },
    })
    const content = result.content as Array<{ type: string; text: string }>
    const parsed = JSON.parse(content[0].text)
    expect(parsed).toEqual({ mock: 'getEscrow' })
    expect((proto as any).getEscrow).toHaveBeenCalledWith('esc-1')
  })

  it('trust_propose_escrow passes all fields including on-chain params', async () => {
    const result = await client.callTool({
      name: 'trust_propose_escrow',
      arguments: {
        seller: 'seller-pub',
        amountCents: 5000,
        taskSpec: { type: 'web-search' },
        fundingMode: 'onchain',
        buyerAddress: '0xBuyer',
        sellerAddress: '0xSeller',
      },
    })
    expect(result.isError).toBeFalsy()
    expect((proto as any).proposeEscrow).toHaveBeenCalledWith(
      expect.objectContaining({
        seller: 'seller-pub',
        amountCents: 5000,
        fundingMode: 'onchain',
        buyerAddress: '0xBuyer',
        sellerAddress: '0xSeller',
        collateralRatio: 0.5,
      }),
    )
  })

  it('trust_submit_oracle_vote passes verdict and rationale', async () => {
    await client.callTool({
      name: 'trust_submit_oracle_vote',
      arguments: { oracleTaskId: 'task-1', verdict: 'pass', rationale: 'looks good' },
    })
    expect((proto as any).submitOracleVote).toHaveBeenCalledWith({
      oracleTaskId: 'task-1',
      verdict: 'pass',
      rationale: 'looks good',
    })
  })

  it('tools with no required params work (oracle_status)', async () => {
    const result = await client.callTool({
      name: 'trust_oracle_status',
      arguments: {},
    })
    expect(result.isError).toBeFalsy()
    expect((proto as any).getOracleStatus).toHaveBeenCalled()
  })
})

describe('error handling', () => {
  it('returns isError: true when protocol method throws', async () => {
    ;(proto as any).getDispute.mockRejectedValueOnce(new Error('not found'))
    const result = await client.callTool({
      name: 'trust_get_dispute',
      arguments: { disputeId: 'bad-id' },
    })
    expect(result.isError).toBe(true)
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0].text).toBe('not found')
  })

  it('handles non-Error throws gracefully', async () => {
    ;(proto as any).getEscrow.mockRejectedValueOnce('string error')
    const result = await client.callTool({
      name: 'trust_escrow_status',
      arguments: { escrowId: 'esc-bad' },
    })
    expect(result.isError).toBe(true)
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0].text).toBe('string error')
  })
})
