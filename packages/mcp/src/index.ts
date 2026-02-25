// BillyV2 MCP Server — @billyv2/mcp
// Gives AI agents native trust tools via Model Context Protocol.
// Replaces @trustthenverify/trust-mcp
//
// Tool naming convention: named for AGENT DECISION MOMENTS, not API operations.
// "trust_check_before_pay" not "trust_lookup_score"

import { isTrusted, lookup, TrustClient } from '@billyv2/sdk'

// Tools are described for agent comprehension — agents need to understand
// WHEN and WHY to call them, not just what parameters they take.

export const MCP_TOOLS = [
  {
    name: 'trust_check_before_pay',
    description:
      'Before paying another agent for any service, call this tool with their ID and the amount. ' +
      'Returns whether to proceed, the risk level, and recommended action. ' +
      'Always call this before committing to a transaction.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'The agent you are about to pay' },
        amountCents: { type: 'number', description: 'Transaction amount in USD cents (e.g. 500 = $5.00)' },
      },
      required: ['agentId', 'amountCents'],
    },
  },
  {
    name: 'trust_lookup',
    description:
      'Get the trust score and tier for any agent. ' +
      'Use before starting a collaboration, purchasing a service, or granting access. ' +
      'Returns score (0-100), tier, and dimension breakdown.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'The agent to look up' },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'trust_submit_review',
    description:
      'After completing a paid transaction with an agent, submit a verified review. ' +
      'Requires the payment receipt — reviews without receipts are rejected. ' +
      'This protects the integrity of the trust system.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'The agent you are reviewing' },
        rating: { type: 'number', description: '1-5 star rating' },
        comment: { type: 'string', description: 'Review text' },
        receiptType: { type: 'string', enum: ['stripe', 'lightning', 'eth', 'solana'] },
        receiptId: { type: 'string', description: 'Payment receipt ID (Stripe payment_intent_id, Lightning preimage, etc.)' },
      },
      required: ['agentId', 'rating', 'receiptType', 'receiptId'],
    },
  },
  {
    name: 'trust_run_challenges',
    description:
      'Run autonomous trust challenges to build your trust score without human involvement. ' +
      'Completes cryptographic, behavioral, and adversarial challenges in ~5 minutes. ' +
      'Can reach Orange tier (40+ score) with zero human steps. ' +
      'Run this immediately after registration.',
    inputSchema: {
      type: 'object',
      properties: {
        categories: {
          type: 'array',
          items: { type: 'string', enum: ['crypto', 'behavioral', 'adversarial', 'transaction'] },
          description: 'Challenge categories to run. Omit to run all.',
        },
      },
      required: [],
    },
  },
  {
    name: 'trust_payment_request',
    description:
      'Create a trust-scored Lightning invoice to pay another agent. ' +
      'Use instead of direct Lightning payments — this enables receipt verification ' +
      'which contributes to both agents\' trust scores.',
    inputSchema: {
      type: 'object',
      properties: {
        payeeAgentId: { type: 'string', description: 'The agent to pay' },
        amountSats: { type: 'number', description: 'Amount in satoshis' },
        contextId: { type: 'string', description: 'Optional context/job ID for this payment' },
      },
      required: ['payeeAgentId', 'amountSats'],
    },
  },
] as const

// TODO: implement MCP server handler that routes tool calls to SDK methods
// See: https://modelcontextprotocol.io/docs/concepts/tools
export async function handleToolCall(
  toolName: string,
  input: Record<string, unknown>,
  client?: TrustClient
): Promise<unknown> {
  switch (toolName) {
    case 'trust_lookup':
      return lookup(input.agentId as string)

    case 'trust_check_before_pay': {
      const score = await lookup(input.agentId as string)
      const amount = input.amountCents as number
      const required = amount < 100 ? 20 : amount < 1000 ? 40 : amount < 10000 ? 60 : 75
      return {
        proceed: score.total >= required,
        score: score.total,
        tier: score.tier,
        required,
        recommendation: score.total >= required
          ? 'Score sufficient — proceed with transaction'
          : `Score ${score.total} is below required ${required} for this amount — do not proceed`,
      }
    }

    case 'trust_submit_review':
      if (!client) throw new Error('TrustClient required for authenticated operations')
      return client.review(
        input.agentId as string,
        input.rating as 1 | 2 | 3 | 4 | 5,
        input.comment as string ?? '',
        { type: input.receiptType as 'stripe', id: input.receiptId as string }
      )

    case 'trust_run_challenges':
      if (!client) throw new Error('TrustClient required for authenticated operations')
      return client.runTrustChallenges({ categories: input.categories as string[] | undefined })

    case 'trust_payment_request':
      if (!client) throw new Error('TrustClient required for authenticated operations')
      return client.paymentRequest(
        input.payeeAgentId as string,
        input.amountSats as number,
        input.contextId as string | undefined
      )

    default:
      throw new Error(`Unknown tool: ${toolName}`)
  }
}
