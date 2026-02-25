// TrustThenVerify MCP Server — @trustthenverify/mcp
// v2: Escrow + Verification Protocol tools for AI agents
//
// Tool naming: named for AGENT DECISION MOMENTS per §10.5
// These are the tools an AI agent needs during a transaction lifecycle.

import { searchAgents, TrustProtocol, type VerificationMethod } from '@trustthenverify/sdk'

export const MCP_TOOLS = [
  {
    name: 'trust_search_agents',
    description:
      'Search for agents by capabilities. Use to discover counterparties before transacting. ' +
      'Returns agents matching the requested capability set.',
    inputSchema: {
      type: 'object',
      properties: {
        capabilities: {
          type: 'array',
          items: { type: 'string' },
          description: 'Capability strings to search for (e.g., ["web-search", "summarization"])',
        },
        match: {
          type: 'string',
          enum: ['any', 'all'],
          description: 'Match mode: "any" = at least one capability matches, "all" = every capability required (default: any)',
        },
      },
      required: ['capabilities'],
    },
  },
  {
    name: 'trust_verify_agent',
    description:
      'Verify an agent controls the identity it claims. Call before any interaction. ' +
      'Sends a signed challenge to the agent\'s endpoint and confirms they hold the private key.',
    inputSchema: {
      type: 'object',
      properties: {
        pubkey: { type: 'string', description: 'The agent\'s secp256k1 public key (hex)' },
      },
      required: ['pubkey'],
    },
  },
  {
    name: 'trust_suggest_collateral',
    description:
      'Get a suggested collateral ratio based on counterparty history and attestations. ' +
      'Use before proposing escrow to determine appropriate collateral levels.',
    inputSchema: {
      type: 'object',
      properties: {
        counterpartyPubkey: { type: 'string', description: 'Counterparty\'s public key (hex)' },
        amountCents: { type: 'number', description: 'Transaction amount in USD cents' },
      },
      required: ['counterpartyPubkey', 'amountCents'],
    },
  },
  {
    name: 'trust_propose_escrow',
    description:
      'Propose a transaction with escrow protection and formal acceptance criteria. ' +
      'Both parties deposit collateral. Deliverables are verified automatically against ' +
      'the acceptance policy — no manual confirmation needed for most tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        seller: { type: 'string', description: 'Seller\'s public key (hex)' },
        amountCents: { type: 'number', description: 'Payment amount in USD cents' },
        collateralRatio: { type: 'number', description: 'Seller collateral as fraction of amount (default 0.5)' },
        taskSpec: { type: 'object', description: 'Task specification (type, params, etc.)' },
        policyId: { type: 'string', description: 'Pre-refined policy ID for automated verification' },
        verificationMethod: {
          type: 'string',
          enum: ['hash_match', 'schema_validation', 'automated_reasoning', 'oracle_consensus', 'buyer_confirm', 'zkml_proof'],
          description: 'How delivery is verified (default: buyer_confirm)',
        },
        timeoutSeconds: { type: 'number', description: 'Escrow timeout in seconds (default: 3600)' },
      },
      required: ['seller', 'amountCents', 'taskSpec'],
    },
  },
  {
    name: 'trust_escrow_status',
    description:
      'Check the current status of an escrow. Use to poll whether the counterparty has ' +
      'accepted, funded, delivered, or whether verification has completed.',
    inputSchema: {
      type: 'object',
      properties: {
        escrowId: { type: 'string', description: 'Escrow ID to check' },
      },
      required: ['escrowId'],
    },
  },
  {
    name: 'trust_deliver',
    description:
      'Submit a deliverable for an escrow. The Verification Gateway checks it ' +
      'against the formal acceptance policy. If it passes, escrow releases automatically. ' +
      'If it fails, escrow refunds the buyer.',
    inputSchema: {
      type: 'object',
      properties: {
        escrowId: { type: 'string', description: 'Escrow ID' },
        deliverable: { type: 'object', description: 'The deliverable output to verify' },
      },
      required: ['escrowId', 'deliverable'],
    },
  },
  {
    name: 'trust_dispute',
    description:
      'Dispute a transaction. Warning: in burn mode, disputing costs you your ' +
      'deposit too. Only dispute if accepting the deliverable is worse than losing your deposit.',
    inputSchema: {
      type: 'object',
      properties: {
        escrowId: { type: 'string', description: 'Escrow ID to dispute' },
        reason: { type: 'string', description: 'Reason for the dispute' },
      },
      required: ['escrowId', 'reason'],
    },
  },
  {
    name: 'trust_create_policy',
    description:
      'Create formal acceptance criteria from a natural language description. ' +
      'Use when defining a new task type. Returns a formal spec with coverage map. ' +
      'Optionally refine with adversarial testing via Argus Codex.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Policy name (e.g., "web_search_v1")' },
        intent: { type: 'string', description: 'Natural language description of acceptance criteria' },
        description: { type: 'string', description: 'Optional longer description' },
      },
      required: ['name', 'intent'],
    },
  },
] as const

// TODO: implement MCP server handler using @modelcontextprotocol/sdk
export async function handleToolCall(
  toolName: string,
  input: Record<string, unknown>,
  protocol?: TrustProtocol
): Promise<unknown> {
  switch (toolName) {
    case 'trust_search_agents':
      return searchAgents(
        input.capabilities as string[],
        { match: (input.match as 'any' | 'all') ?? 'any' }
      )

    case 'trust_verify_agent':
      if (!protocol) throw new Error('TrustProtocol required')
      return protocol.verify(input.pubkey as string)

    case 'trust_suggest_collateral':
      if (!protocol) throw new Error('TrustProtocol required')
      return protocol.suggestCollateral(
        input.counterpartyPubkey as string,
        input.amountCents as number
      )

    case 'trust_propose_escrow':
      if (!protocol) throw new Error('TrustProtocol required')
      return protocol.proposeEscrow({
        seller: input.seller as string,
        amountCents: input.amountCents as number,
        collateralRatio: (input.collateralRatio as number) ?? 0.5,
        taskSpec: input.taskSpec as Record<string, unknown>,
        policyId: input.policyId as string | undefined,
        verificationMethod: input.verificationMethod as VerificationMethod | undefined,
        timeoutSeconds: input.timeoutSeconds as number | undefined,
      })

    case 'trust_escrow_status':
      if (!protocol) throw new Error('TrustProtocol required')
      return protocol.getEscrow(input.escrowId as string)

    case 'trust_deliver':
      if (!protocol) throw new Error('TrustProtocol required')
      return protocol.deliver(
        input.escrowId as string,
        input.deliverable as Record<string, unknown>
      )

    case 'trust_dispute':
      if (!protocol) throw new Error('TrustProtocol required')
      return protocol.disputeEscrow(input.escrowId as string, input.reason as string)

    case 'trust_create_policy':
      if (!protocol) throw new Error('TrustProtocol required')
      return protocol.createPolicy({
        name: input.name as string,
        intent: input.intent as string,
        description: input.description as string | undefined,
      })

    default:
      throw new Error(`Unknown tool: ${toolName}`)
  }
}
