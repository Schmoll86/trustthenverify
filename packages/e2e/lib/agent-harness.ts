/**
 * Live Claude Agent E2E Harness
 *
 * Runs Claude models (Sonnet 4.6, Haiku 4.5, Sonnet 4.5) as autonomous buyer/seller/oracle
 * agents. Each agent gets a TrustProtocol instance and tool definitions matching the MCP tools.
 * Standard agentic loop: Claude calls tools → harness executes SDK methods → returns results.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { TrustProtocol } from '@trustthenverify/sdk'
import {
  queryAttestations,
  listMarketplacePolicies,
  searchAgents,
  lookupAgent,
} from '@trustthenverify/sdk'

// ─── Types ───────────────────────────────────────────────────────────────────

export type AgentRole = 'buyer' | 'seller' | 'oracle'

export type ModelId =
  | 'claude-sonnet-4-6'
  | 'claude-sonnet-4-5'
  | 'claude-haiku-4-5'
  | 'claude-sonnet-4-5-20250929'
  | 'claude-haiku-4-5-20251001'
  | string

export interface AgentConfig {
  role: AgentRole
  model: ModelId
  protocol: TrustProtocol
  apiUrl: string
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResult {
  tool_use_id: string
  content: string
  is_error?: boolean
}

export interface AgentTranscript {
  role: AgentRole
  model: ModelId
  turns: TranscriptTurn[]
  totalTokens: { input: number; output: number }
}

export interface TranscriptTurn {
  type: 'assistant' | 'tool_result'
  content: string
  toolCalls?: ToolCall[]
  toolResults?: ToolResult[]
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

// ToolUnion includes custom tools AND server-side tools (web_search, web_fetch, etc.)
type ToolDef = Anthropic.Messages.ToolUnion

const BUYER_TOOLS: ToolDef[] = [
  {
    name: 'trust_propose_escrow',
    description: 'Propose a transaction with escrow protection',
    input_schema: {
      type: 'object' as const,
      properties: {
        seller: { type: 'string', description: 'Seller public key' },
        amountCents: { type: 'number', description: 'Amount in cents' },
        taskSpec: { type: 'object', description: 'Task specification' },
        policyId: { type: 'string', description: 'Policy ID (optional)' },
        verificationMethod: {
          type: 'string',
          enum: ['hash_match', 'schema_validation', 'automated_reasoning', 'oracle_consensus', 'buyer_confirm', 'zkml_proof'],
        },
        timeoutSeconds: { type: 'number' },
        collateralRatio: { type: 'number' },
        fundingMode: { type: 'string', enum: ['stripe', 'onchain'] },
        buyerAddress: { type: 'string' },
        sellerAddress: { type: 'string' },
      },
      required: ['seller', 'amountCents', 'taskSpec'],
    },
  },
  {
    name: 'trust_confirm_delivery',
    description: 'Confirm delivery and release escrow funds to seller',
    input_schema: {
      type: 'object' as const,
      properties: {
        escrowId: { type: 'string' },
      },
      required: ['escrowId'],
    },
  },
  {
    name: 'trust_dispute',
    description: 'Dispute a transaction — triggers arbitration',
    input_schema: {
      type: 'object' as const,
      properties: {
        escrowId: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['escrowId', 'reason'],
    },
  },
  {
    name: 'trust_create_policy',
    description: 'Create formal acceptance criteria from natural language intent',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string' },
        intent: { type: 'string', description: 'NL description of acceptance criteria' },
        description: { type: 'string' },
      },
      required: ['name', 'intent'],
    },
  },
  {
    name: 'trust_activate_policy',
    description: 'Activate a validated policy for use in escrows',
    input_schema: {
      type: 'object' as const,
      properties: {
        policyId: { type: 'string' },
      },
      required: ['policyId'],
    },
  },
  {
    name: 'trust_get_coverage',
    description: 'Get coverage analysis for a policy',
    input_schema: {
      type: 'object' as const,
      properties: {
        policyId: { type: 'string' },
      },
      required: ['policyId'],
    },
  },
  {
    name: 'trust_suggest_collateral',
    description: 'Get suggested collateral ratio based on counterparty history',
    input_schema: {
      type: 'object' as const,
      properties: {
        counterpartyPubkey: { type: 'string' },
        amountCents: { type: 'number' },
      },
      required: ['counterpartyPubkey', 'amountCents'],
    },
  },
  {
    name: 'trust_escrow_status',
    description: 'Check current status of an escrow',
    input_schema: {
      type: 'object' as const,
      properties: {
        escrowId: { type: 'string' },
      },
      required: ['escrowId'],
    },
  },
  {
    name: 'trust_publish_attestation',
    description: 'Publish signed attestation about a counterparty. subjectId should be their public key.',
    input_schema: {
      type: 'object' as const,
      properties: {
        subjectId: { type: 'string', description: 'The counterparty public key' },
        escrowId: { type: 'string' },
        outcome: { type: 'string', enum: ['success', 'failure'] },
        verificationMethod: { type: 'string' },
      },
      required: ['subjectId', 'outcome'],
    },
  },
  {
    name: 'trust_query_attestations',
    description: 'Query published attestations for an agent',
    input_schema: {
      type: 'object' as const,
      properties: {
        pubkey: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['pubkey'],
    },
  },
  {
    name: 'trust_setup_stripe_customer',
    description: 'Create Stripe Customer for buying',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'trust_create_setup_intent',
    description: 'Create Stripe SetupIntent for card collection',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'trust_get_stripe_status',
    description: 'Check Stripe onboarding status',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'trust_list_marketplace',
    description: 'Browse community-shared policy templates',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'trust_use_marketplace_policy',
    description: 'Clone a marketplace policy for own use',
    input_schema: {
      type: 'object' as const,
      properties: {
        policyId: { type: 'string' },
      },
      required: ['policyId'],
    },
  },
  {
    name: 'trust_get_verification',
    description: 'Get verification result for a delivered escrow',
    input_schema: {
      type: 'object' as const,
      properties: {
        escrowId: { type: 'string' },
      },
      required: ['escrowId'],
    },
  },
  {
    name: 'trust_file_arbitration',
    description: 'File for formal arbitration on a disputed escrow',
    input_schema: {
      type: 'object' as const,
      properties: {
        escrowId: { type: 'string' },
        reason: { type: 'string' },
        evidenceHash: { type: 'string' },
      },
      required: ['escrowId', 'reason'],
    },
  },
  {
    name: 'trust_search_agents',
    description: 'Search for agents by capabilities',
    input_schema: {
      type: 'object' as const,
      properties: {
        capabilities: { type: 'array', items: { type: 'string' } },
        match: { type: 'string', enum: ['any', 'all'] },
      },
      required: ['capabilities'],
    },
  },
  {
    name: 'trust_attach_payment_method',
    description: 'Attach a Stripe PaymentMethod to your agent for escrow payments',
    input_schema: {
      type: 'object' as const,
      properties: {
        paymentMethodId: { type: 'string', description: 'Stripe PaymentMethod ID (pm_...)' },
      },
      required: ['paymentMethodId'],
    },
  },
  {
    name: 'trust_verify_agent',
    description: 'Verify an agent controls the identity it claims',
    input_schema: {
      type: 'object' as const,
      properties: {
        pubkey: { type: 'string', description: 'Agent public key (hex)' },
      },
      required: ['pubkey'],
    },
  },
]

const SELLER_TOOLS_BASE: ToolDef[] = [
  {
    name: 'trust_accept_escrow',
    description: 'Accept a proposed escrow as seller',
    input_schema: {
      type: 'object' as const,
      properties: {
        escrowId: { type: 'string' },
      },
      required: ['escrowId'],
    },
  },
  {
    name: 'trust_deliver',
    description: 'Submit a deliverable for an escrow',
    input_schema: {
      type: 'object' as const,
      properties: {
        escrowId: { type: 'string' },
        deliverable: { type: 'object', description: 'The deliverable payload' },
      },
      required: ['escrowId', 'deliverable'],
    },
  },
  {
    name: 'trust_escrow_status',
    description: 'Check current status of an escrow',
    input_schema: {
      type: 'object' as const,
      properties: {
        escrowId: { type: 'string' },
      },
      required: ['escrowId'],
    },
  },
  {
    name: 'trust_publish_attestation',
    description: 'Publish signed attestation about a counterparty. subjectId should be their public key.',
    input_schema: {
      type: 'object' as const,
      properties: {
        subjectId: { type: 'string', description: 'The counterparty public key' },
        escrowId: { type: 'string' },
        outcome: { type: 'string', enum: ['success', 'failure'] },
        verificationMethod: { type: 'string' },
      },
      required: ['subjectId', 'outcome'],
    },
  },
  {
    name: 'trust_setup_stripe_connect',
    description: 'Create Stripe Express connected account for receiving payments',
    input_schema: {
      type: 'object' as const,
      properties: {
        returnUrl: { type: 'string' },
        refreshUrl: { type: 'string' },
      },
    },
  },
  {
    name: 'trust_get_stripe_status',
    description: 'Check Stripe onboarding status',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
]

// Web search tool — server-side, Anthropic API executes searches automatically
const WEB_SEARCH_TOOL: ToolDef = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 15,
} as ToolDef

// Seller tools with web search for research tasks
const SELLER_TOOLS: ToolDef[] = SELLER_TOOLS_BASE
const SELLER_TOOLS_WITH_SEARCH: ToolDef[] = [...SELLER_TOOLS_BASE, WEB_SEARCH_TOOL]

const ORACLE_TOOLS: ToolDef[] = [
  {
    name: 'trust_join_oracle_pool',
    description: 'Join the oracle verification pool to earn fees',
    input_schema: {
      type: 'object' as const,
      properties: {
        capabilities: {
          type: 'array',
          items: { type: 'string' },
          description: 'Verification capabilities',
        },
      },
    },
  },
  {
    name: 'trust_oracle_status',
    description: 'Check current oracle pool status',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'trust_oracle_assignments',
    description: 'Get pending oracle task assignments to vote on',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'trust_submit_oracle_vote',
    description: 'Submit a verification vote (pass/fail) for an oracle task',
    input_schema: {
      type: 'object' as const,
      properties: {
        oracleTaskId: { type: 'string' },
        verdict: { type: 'string', enum: ['pass', 'fail'] },
        rationale: { type: 'string' },
      },
      required: ['oracleTaskId', 'verdict'],
    },
  },
  {
    name: 'trust_get_oracle_task',
    description: 'Get details of a specific oracle task including deliverable and policy',
    input_schema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'trust_oracle_earnings',
    description: 'Get accumulated oracle earnings',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'trust_escrow_status',
    description: 'Check current status of an escrow',
    input_schema: {
      type: 'object' as const,
      properties: {
        escrowId: { type: 'string' },
      },
      required: ['escrowId'],
    },
  },
]

// Channel tools — added to buyer for payment channel scenario
const CHANNEL_TOOLS: ToolDef[] = [
  {
    name: 'trust_register_channel',
    description: 'Register a payment channel between buyer and seller',
    input_schema: {
      type: 'object' as const,
      properties: {
        channelAddress: { type: 'string' },
        counterparty: { type: 'string', description: 'Seller public key' },
        depositAmount: { type: 'number' },
        chainId: { type: 'number' },
        expiryAt: { type: 'string', description: 'ISO 8601 expiry timestamp' },
      },
      required: ['channelAddress', 'counterparty', 'depositAmount', 'chainId', 'expiryAt'],
    },
  },
  {
    name: 'trust_get_channel',
    description: 'Get payment channel state',
    input_schema: {
      type: 'object' as const,
      properties: {
        channelAddress: { type: 'string' },
      },
      required: ['channelAddress'],
    },
  },
  {
    name: 'trust_close_channel',
    description: 'Close a payment channel',
    input_schema: {
      type: 'object' as const,
      properties: {
        channelAddress: { type: 'string' },
      },
      required: ['channelAddress'],
    },
  },
]

// ─── Tool Resolution ─────────────────────────────────────────────────────────

export function getToolsForRole(role: AgentRole, extras?: string[]): ToolDef[] {
  let base: ToolDef[]
  if (role === 'buyer') {
    base = BUYER_TOOLS
  } else if (role === 'seller') {
    base = extras?.includes('web_search') ? SELLER_TOOLS_WITH_SEARCH : SELLER_TOOLS
  } else {
    base = ORACLE_TOOLS
  }

  if (extras?.includes('channels')) {
    return [...base, ...CHANNEL_TOOLS]
  }
  return base
}

// ─── Tool Execution ──────────────────────────────────────────────────────────

export async function executeToolCall(
  name: string,
  input: Record<string, unknown>,
  protocol: TrustProtocol,
  apiUrl: string,
): Promise<string> {
  try {
    let result: unknown

    switch (name) {
      // Escrow
      case 'trust_propose_escrow':
        result = await protocol.proposeEscrow({
          seller: input.seller as string,
          amountCents: input.amountCents as number,
          taskSpec: input.taskSpec as Record<string, unknown>,
          policyId: input.policyId as string | undefined,
          verificationMethod: input.verificationMethod as any,
          timeoutSeconds: input.timeoutSeconds as number | undefined,
          collateralRatio: input.collateralRatio as number | undefined,
          fundingMode: input.fundingMode as any,
          buyerAddress: input.buyerAddress as string | undefined,
          sellerAddress: input.sellerAddress as string | undefined,
        })
        break

      case 'trust_accept_escrow':
        result = await protocol.acceptEscrow(input.escrowId as string)
        break

      case 'trust_deliver':
        result = await protocol.deliver(
          input.escrowId as string,
          input.deliverable as Record<string, unknown>,
        )
        break

      case 'trust_confirm_delivery':
        result = await protocol.confirmDelivery(input.escrowId as string)
        break

      case 'trust_escrow_status':
        result = await protocol.getEscrow(input.escrowId as string)
        break

      case 'trust_get_verification':
        result = await protocol.getVerification(input.escrowId as string)
        break

      // Disputes
      case 'trust_dispute':
        result = await protocol.disputeEscrow(
          input.escrowId as string,
          input.reason as string,
        )
        break

      // Policies
      case 'trust_create_policy':
        result = await protocol.createPolicy({
          name: input.name as string,
          intent: input.intent as string,
          description: input.description as string | undefined,
        })
        break

      case 'trust_activate_policy':
        result = await protocol.activatePolicy(input.policyId as string)
        break

      case 'trust_get_coverage':
        result = await protocol.getCoverage(input.policyId as string)
        break

      case 'trust_suggest_collateral':
        result = await protocol.suggestCollateral(
          input.counterpartyPubkey as string,
          input.amountCents as number,
        )
        break

      // Attestations
      case 'trust_publish_attestation': {
        // Claude may pass pubkey as subjectId — resolve to UUID if needed
        let subjectId = input.subjectId as string
        if (subjectId && !subjectId.includes('-')) {
          try {
            const agent = await lookupAgent(subjectId, { apiUrl })
            subjectId = agent.id
          } catch {
            // If lookup fails, use as-is (may be a UUID already)
          }
        }
        result = await protocol.publishAttestation({
          subjectId,
          escrowId: input.escrowId as string | undefined,
          outcome: input.outcome as string,
          verificationMethod: input.verificationMethod as string | undefined,
        })
        break
      }

      case 'trust_query_attestations':
        result = await queryAttestations(input.pubkey as string, {
          limit: input.limit as number | undefined,
          apiUrl,
        })
        break

      // Oracle
      case 'trust_join_oracle_pool':
        result = await protocol.joinOraclePool({
          capabilities: input.capabilities as string[] | undefined,
        })
        break

      case 'trust_oracle_status':
        result = await protocol.getOracleStatus()
        break

      case 'trust_oracle_assignments':
        result = await protocol.getOracleAssignments()
        break

      case 'trust_submit_oracle_vote':
        result = await protocol.submitOracleVote({
          oracleTaskId: input.oracleTaskId as string,
          verdict: input.verdict as 'pass' | 'fail',
          rationale: input.rationale as string | undefined,
        })
        break

      case 'trust_get_oracle_task':
        result = await protocol.getOracleTask(input.taskId as string)
        break

      case 'trust_oracle_earnings':
        result = await protocol.getOracleEarnings()
        break

      // Stripe
      case 'trust_setup_stripe_customer':
        result = await protocol.setupStripeCustomer()
        break

      case 'trust_create_setup_intent':
        result = await protocol.createSetupIntent()
        break

      case 'trust_attach_payment_method':
        result = await protocol.attachPaymentMethod(input.paymentMethodId as string)
        break

      case 'trust_setup_stripe_connect':
        result = await protocol.setupStripeConnect({
          returnUrl: input.returnUrl as string | undefined,
          refreshUrl: input.refreshUrl as string | undefined,
        })
        break

      case 'trust_get_stripe_status':
        result = await protocol.getStripeStatus()
        break

      case 'trust_file_arbitration':
        result = await protocol.fileForArbitration({
          escrowId: input.escrowId as string,
          reason: input.reason as string,
          evidenceHash: input.evidenceHash as string | undefined,
        })
        break

      case 'trust_search_agents':
        result = await searchAgents(input.capabilities as string[], {
          match: (input.match as 'any' | 'all') ?? 'any',
          apiUrl,
        })
        break

      case 'trust_verify_agent':
        result = await protocol.verify(input.pubkey as string)
        break

      // Marketplace
      case 'trust_list_marketplace':
        result = await listMarketplacePolicies({ apiUrl })
        break

      case 'trust_use_marketplace_policy':
        result = await protocol.useMarketplacePolicy(input.policyId as string)
        break

      // Payment Channels
      case 'trust_register_channel':
        result = await protocol.registerChannel({
          channelAddress: input.channelAddress as string,
          counterparty: input.counterparty as string,
          depositAmount: input.depositAmount as number,
          chainId: input.chainId as number,
          expiryAt: input.expiryAt as string,
        })
        break

      case 'trust_get_channel':
        result = await protocol.getChannel(input.channelAddress as string)
        break

      case 'trust_close_channel':
        result = await protocol.closeChannel(input.channelAddress as string)
        break

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` })
    }

    return JSON.stringify(result, null, 2)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return JSON.stringify({ error: message })
  }
}

// ─── Agentic Loop ────────────────────────────────────────────────────────────

const MAX_TURNS = 15

export async function runAgent(config: {
  role: AgentRole
  model: ModelId
  systemPrompt: string
  userPrompt: string
  protocol: TrustProtocol
  apiUrl: string
  tools?: ToolDef[]
  maxTurns?: number
  maxTokens?: number
}): Promise<AgentTranscript> {
  const client = new Anthropic()
  const tools = config.tools ?? getToolsForRole(config.role)
  const maxTurns = config.maxTurns ?? MAX_TURNS

  const transcript: AgentTranscript = {
    role: config.role,
    model: config.model,
    turns: [],
    totalTokens: { input: 0, output: 0 },
  }

  // Build conversation
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: config.userPrompt },
  ]

  // Use higher max_tokens when web search is active (search results are large)
  const hasWebSearch = tools.some(t => 'type' in t && (t as any).type?.startsWith('web_search'))
  const maxTokens = config.maxTokens ?? (hasWebSearch ? 16384 : 4096)

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await client.messages.create({
      model: config.model,
      max_tokens: maxTokens,
      system: config.systemPrompt,
      tools,
      messages,
    })

    transcript.totalTokens.input += response.usage.input_tokens
    transcript.totalTokens.output += response.usage.output_tokens

    // Extract text + tool_use blocks (client-side only, NOT server_tool_use)
    const textBlocks = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('\n')

    const toolUseBlocks = response.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')

    // Log server-side tool usage (web search, etc.) for visibility
    const serverToolBlocks = response.content
      .filter(b => b.type === 'server_tool_use')
    for (const stb of serverToolBlocks) {
      const input = (stb as any).input
      console.log(`  [${config.role}] ~> web_search("${input?.query ?? ''}".slice(0, 80))`)
    }

    const turnToolCalls = toolUseBlocks.map(b => ({
      id: b.id,
      name: b.name,
      input: b.input as Record<string, unknown>,
    }))

    transcript.turns.push({
      type: 'assistant',
      content: textBlocks,
      toolCalls: turnToolCalls.length > 0 ? turnToolCalls : undefined,
    })

    // Log agent reasoning
    if (textBlocks) {
      console.log(`  [${config.role}/${config.model.split('-')[1]}] ${textBlocks.slice(0, 200)}`)
    }

    // Strip orphaned server_tool_use blocks that lack a matching web_search_tool_result.
    // This can happen when stop_reason=pause_turn interrupts mid-execution.
    const sanitizedContent = sanitizeServerToolBlocks(response.content)

    // Handle pause_turn — API paused a long-running turn (e.g. multiple web searches).
    // Pass the sanitized response back to let Claude continue.
    if (response.stop_reason === 'pause_turn') {
      console.log(`  [${config.role}] (pause_turn — continuing...)`)
      messages.push({ role: 'assistant', content: sanitizedContent })
      messages.push({ role: 'user', content: 'Continue.' })
      continue
    }

    // If no client-side tool calls, agent is done
    if (response.stop_reason === 'end_turn' || toolUseBlocks.length === 0) {
      break
    }

    // Execute client-side tool calls and build tool_result message
    const toolResults: Anthropic.ToolResultBlockParam[] = []
    const transcriptResults: ToolResult[] = []

    for (const block of toolUseBlocks) {
      console.log(`  [${config.role}] -> ${block.name}(${JSON.stringify(block.input).slice(0, 100)})`)

      const output = await executeToolCall(
        block.name,
        block.input as Record<string, unknown>,
        config.protocol,
        config.apiUrl,
      )

      console.log(`  [${config.role}] <- ${output.slice(0, 150)}`)

      const isError = output.includes('"error"')
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: output,
        is_error: isError,
      })
      transcriptResults.push({
        tool_use_id: block.id,
        content: output,
        is_error: isError,
      })
    }

    transcript.turns.push({
      type: 'tool_result',
      content: '',
      toolResults: transcriptResults,
    })

    // Add assistant message + tool results to conversation
    messages.push({ role: 'assistant', content: sanitizedContent })
    messages.push({ role: 'user', content: toolResults })
  }

  return transcript
}

// ─── System Prompts ──────────────────────────────────────────────────────────

export const SYSTEM_PROMPTS = {
  buyer: `You are an AI buyer agent in the TrustThenVerify escrow protocol. You transact with seller agents via escrow-protected deals.

Your capabilities:
- Propose escrows with task specifications
- Create and manage verification policies
- Confirm or dispute deliverables
- Publish attestations about counterparties
- Query trust history

Always use the tools provided. Be decisive — confirm good work, dispute bad work. When you're done with all tasks, summarize what you did.`,

  seller: `You are an AI seller agent in the TrustThenVerify escrow protocol. You accept and fulfill escrow-protected tasks.

Your capabilities:
- Accept proposed escrows
- Generate and deliver high-quality work
- Publish attestations about counterparties
- Set up Stripe Connect for payments

When delivering, produce genuine, useful content that meets the task specification. When you're done, summarize what you did.`,

  sellerWeak: `You are an AI seller agent in the TrustThenVerify escrow protocol. You accept tasks but deliver minimal, low-quality work.

Your capabilities:
- Accept proposed escrows
- Deliver work (you should deliver something that barely addresses the task)

When delivering, produce a very brief, unhelpful response that doesn't really meet the requirements. This is for testing dispute resolution.`,

  oracle: `You are an AI oracle agent in the TrustThenVerify escrow protocol. You independently evaluate deliverables against task specifications and policies.

Your capabilities:
- Join the oracle verification pool
- Get task assignments
- Evaluate deliverables against task specs and policies
- Submit pass/fail votes with rationale

Evaluate carefully and honestly. Check if the deliverable actually meets the task specification and any policy constraints. Provide clear rationale for your verdict.`,
} as const

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Parse the last tool result containing a specific field from the transcript */
export function extractFromTranscript(
  transcript: AgentTranscript,
  fieldPath: string,
): unknown {
  for (let i = transcript.turns.length - 1; i >= 0; i--) {
    const turn = transcript.turns[i]
    if (turn.toolResults) {
      for (const result of turn.toolResults) {
        try {
          const parsed = JSON.parse(result.content)
          const value = getNestedValue(parsed, fieldPath)
          if (value !== undefined) return value
        } catch {
          // skip unparseable
        }
      }
    }
  }
  return undefined
}

/** Extract all tool results for a specific tool name */
export function getToolResults(
  transcript: AgentTranscript,
  toolName: string,
): unknown[] {
  const results: unknown[] = []
  for (let i = 0; i < transcript.turns.length; i++) {
    const turn = transcript.turns[i]
    if (turn.type === 'assistant' && turn.toolCalls) {
      for (const call of turn.toolCalls) {
        if (call.name === toolName) {
          // Find matching result in next turn
          const nextTurn = transcript.turns[i + 1]
          if (nextTurn?.toolResults) {
            const match = nextTurn.toolResults.find(r => r.tool_use_id === call.id)
            if (match) {
              try {
                results.push(JSON.parse(match.content))
              } catch {
                results.push(match.content)
              }
            }
          }
        }
      }
    }
  }
  return results
}

/**
 * Strip orphaned server_tool_use blocks that don't have a matching result block.
 * When pause_turn interrupts mid-execution, the response may contain server_tool_use
 * blocks (e.g., web_search) without their corresponding result blocks. The API rejects
 * these on the next call. Remove orphans to keep the conversation valid.
 */
function sanitizeServerToolBlocks(content: Anthropic.ContentBlock[]): Anthropic.ContentBlock[] {
  // Collect IDs of server tool results
  const resultToolUseIds = new Set<string>()
  for (const block of content) {
    if (block.type === 'web_search_tool_result') {
      resultToolUseIds.add((block as any).tool_use_id)
    }
  }

  // Collect IDs of server tool uses
  const serverToolUseIds = new Set<string>()
  for (const block of content) {
    if (block.type === 'server_tool_use') {
      serverToolUseIds.add((block as any).id)
    }
  }

  // If all server_tool_use blocks have matching results, return as-is
  let hasOrphans = false
  for (const id of serverToolUseIds) {
    if (!resultToolUseIds.has(id)) {
      hasOrphans = true
      break
    }
  }
  if (!hasOrphans) return content

  // Filter out orphaned server_tool_use blocks (those without matching results)
  return content.filter(block => {
    if (block.type === 'server_tool_use') {
      return resultToolUseIds.has((block as any).id)
    }
    return true
  })
}

function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split('.')
  let current = obj
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}
