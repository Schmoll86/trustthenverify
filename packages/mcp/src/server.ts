// TrustThenVerify MCP Server — tool registration
// Split from index.ts for testability.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  TrustProtocol,
  searchAgents,
  queryAttestations,
  listMarketplacePolicies,
  type VerificationMethod,
  type FundingMode,
} from '@trustthenverify/sdk'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  return { content: [{ type: 'text' as const, text: message }], isError: true as const }
}

// ---------------------------------------------------------------------------
// createServer — registers all 41 tools on the McpServer instance
// ---------------------------------------------------------------------------

// Wrapper to avoid TS2589 "Type instantiation is excessively deep" from McpServer generics
function tool(
  server: McpServer,
  name: string,
  description: string,
  schema: Record<string, z.ZodTypeAny>,
  handler: (params: Record<string, any>) => Promise<any>,
) {
  ;(server.tool as any)(name, description, schema, handler)
}

export function createServer(protocol: TrustProtocol, apiUrl: string): McpServer {
  const server = new McpServer({
    name: 'trust-then-verify',
    version: '0.2.0',
  })

  // 1. trust_search_agents
  tool(server,
    'trust_search_agents',
    'Search for agents by capabilities. Returns agents matching the requested capability set.',
    {
      capabilities: z.array(z.string()).describe('Capability strings to search for'),
      match: z.enum(['any', 'all']).optional().describe('Match mode (default: any)'),
    },
    async ({ capabilities, match }) => {
      try {
        const result = await searchAgents(capabilities, { match: match ?? 'any', apiUrl })
        return ok(result)
      } catch (err) { return fail(err) }
    },
  )

  // 2. trust_verify_agent
  tool(server,
    'trust_verify_agent',
    'Verify an agent controls the identity it claims by sending a signed challenge.',
    { pubkey: z.string().describe("Agent's secp256k1 public key (hex)") },
    async ({ pubkey }) => {
      try { return ok(await protocol.verify(pubkey)) }
      catch (err) { return fail(err) }
    },
  )

  // 3. trust_suggest_collateral
  tool(server,
    'trust_suggest_collateral',
    'Get a suggested collateral ratio based on counterparty history and attestations.',
    {
      counterpartyPubkey: z.string().describe("Counterparty's public key (hex)"),
      amountCents: z.number().describe('Transaction amount in USD cents'),
    },
    async ({ counterpartyPubkey, amountCents }) => {
      try { return ok(await protocol.suggestCollateral(counterpartyPubkey, amountCents)) }
      catch (err) { return fail(err) }
    },
  )

  // 4. trust_spawn_agent
  tool(server,
    'trust_spawn_agent',
    'Register a new agent with the protocol. Returns the created agent record.',
    {
      publicKey: z.string().describe('secp256k1 public key (hex)'),
      endpoint: z.string().optional().describe('Agent HTTP endpoint URL'),
      name: z.string().optional().describe('Human-readable name'),
      capabilities: z.array(z.string()).optional().describe('Capability strings'),
    },
    async (params) => {
      try { return ok(await protocol.spawnAgent(params as any)) }
      catch (err) { return fail(err) }
    },
  )

  // 5. trust_propose_escrow
  tool(server,
    'trust_propose_escrow',
    'Propose a transaction with escrow protection and formal acceptance criteria.',
    {
      seller: z.string().describe("Seller's public key (hex)"),
      amountCents: z.number().describe('Payment amount in USD cents'),
      taskSpec: z.record(z.unknown()).describe('Task specification object'),
      policyId: z.string().optional().describe('Pre-refined policy ID for automated verification'),
      verificationMethod: z.enum([
        'hash_match', 'schema_validation', 'automated_reasoning',
        'oracle_consensus', 'buyer_confirm', 'zkml_proof',
      ]).optional().describe('How delivery is verified (default: buyer_confirm)'),
      timeoutSeconds: z.number().optional().describe('Escrow timeout in seconds (default: 3600)'),
      collateralRatio: z.number().optional().describe('Seller collateral as fraction of amount (default: 0.5)'),
      fundingMode: z.enum(['stripe', 'onchain']).optional().describe('Payment method (default: stripe)'),
      buyerAddress: z.string().optional().describe('Buyer Ethereum address (on-chain only)'),
      sellerAddress: z.string().optional().describe('Seller Ethereum address (on-chain only)'),
    },
    async (params) => {
      try {
        return ok(await protocol.proposeEscrow({
          seller: params.seller,
          amountCents: params.amountCents,
          collateralRatio: params.collateralRatio ?? 0.5,
          taskSpec: params.taskSpec,
          policyId: params.policyId,
          verificationMethod: params.verificationMethod as VerificationMethod | undefined,
          timeoutSeconds: params.timeoutSeconds,
          fundingMode: params.fundingMode as FundingMode | undefined,
          buyerAddress: params.buyerAddress,
          sellerAddress: params.sellerAddress,
        }))
      } catch (err) { return fail(err) }
    },
  )

  // 6. trust_accept_escrow
  tool(server,
    'trust_accept_escrow',
    'Accept a proposed escrow as the seller.',
    { escrowId: z.string().describe('Escrow ID') },
    async ({ escrowId }) => {
      try { return ok(await protocol.acceptEscrow(escrowId)) }
      catch (err) { return fail(err) }
    },
  )

  // 7. trust_fund_escrow
  tool(server,
    'trust_fund_escrow',
    'Notify the API that on-chain funding has been submitted for an escrow.',
    { escrowId: z.string().describe('Escrow ID') },
    async ({ escrowId }) => {
      try { return ok(await protocol.fundEscrow(escrowId)) }
      catch (err) { return fail(err) }
    },
  )

  // 8. trust_escrow_status
  tool(server,
    'trust_escrow_status',
    'Check the current status of an escrow.',
    { escrowId: z.string().describe('Escrow ID') },
    async ({ escrowId }) => {
      try { return ok(await protocol.getEscrow(escrowId)) }
      catch (err) { return fail(err) }
    },
  )

  // 9. trust_deliver
  tool(server,
    'trust_deliver',
    'Submit a deliverable for an escrow. The Verification Gateway checks it against the acceptance policy.',
    {
      escrowId: z.string().describe('Escrow ID'),
      deliverable: z.record(z.unknown()).describe('The deliverable output to verify'),
    },
    async ({ escrowId, deliverable }) => {
      try { return ok(await protocol.deliver(escrowId, deliverable)) }
      catch (err) { return fail(err) }
    },
  )

  // 10. trust_confirm_delivery
  tool(server,
    'trust_confirm_delivery',
    'Manually confirm delivery as the buyer (for buyer_confirm verification method).',
    { escrowId: z.string().describe('Escrow ID') },
    async ({ escrowId }) => {
      try { return ok(await protocol.confirmDelivery(escrowId)) }
      catch (err) { return fail(err) }
    },
  )

  // 11. trust_get_verification
  tool(server,
    'trust_get_verification',
    'Get the verification result for a delivered escrow.',
    { escrowId: z.string().describe('Escrow ID') },
    async ({ escrowId }) => {
      try { return ok(await protocol.getVerification(escrowId)) }
      catch (err) { return fail(err) }
    },
  )

  // 12. trust_dispute
  tool(server,
    'trust_dispute',
    'Dispute a transaction. Warning: in burn mode, disputing costs your deposit too.',
    {
      escrowId: z.string().describe('Escrow ID'),
      reason: z.string().describe('Reason for the dispute'),
    },
    async ({ escrowId, reason }) => {
      try { return ok(await protocol.disputeEscrow(escrowId, reason)) }
      catch (err) { return fail(err) }
    },
  )

  // 13. trust_file_arbitration
  tool(server,
    'trust_file_arbitration',
    'File for formal arbitration on an escrow dispute.',
    {
      escrowId: z.string().describe('Escrow ID'),
      reason: z.string().describe('Reason for arbitration'),
      evidenceHash: z.string().optional().describe('SHA-256 hash of evidence bundle'),
    },
    async (params) => {
      try { return ok(await protocol.fileForArbitration(params as any)) }
      catch (err) { return fail(err) }
    },
  )

  // 14. trust_get_dispute
  tool(server,
    'trust_get_dispute',
    'Get details of a dispute.',
    { disputeId: z.string().describe('Dispute ID') },
    async ({ disputeId }) => {
      try { return ok(await protocol.getDispute(disputeId)) }
      catch (err) { return fail(err) }
    },
  )

  // 15. trust_submit_ruling
  tool(server,
    'trust_submit_ruling',
    'Submit a ruling on a dispute (arbitrator only).',
    {
      disputeId: z.string().describe('Dispute ID'),
      ruling: z.string().describe('The ruling decision'),
    },
    async ({ disputeId, ruling }) => {
      try { return ok(await protocol.submitRuling(disputeId, { ruling })) }
      catch (err) { return fail(err) }
    },
  )

  // 16. trust_create_policy
  tool(server,
    'trust_create_policy',
    'Create formal acceptance criteria from a natural language description.',
    {
      name: z.string().describe('Policy name (e.g., "web_search_v1")'),
      intent: z.string().describe('Natural language description of acceptance criteria'),
      description: z.string().optional().describe('Optional longer description'),
    },
    async (params) => {
      try { return ok(await protocol.createPolicy(params as any)) }
      catch (err) { return fail(err) }
    },
  )

  // 17. trust_get_coverage
  tool(server,
    'trust_get_coverage',
    'Get the coverage map for a policy showing which clauses have formal constraints.',
    { policyId: z.string().describe('Policy ID') },
    async ({ policyId }) => {
      try { return ok(await protocol.getCoverage(policyId)) }
      catch (err) { return fail(err) }
    },
  )

  // 18. trust_revise_policy
  tool(server,
    'trust_revise_policy',
    'Revise a policy with a new intent. Re-translates and rebuilds coverage.',
    {
      policyId: z.string().describe('Policy ID'),
      intent: z.string().describe('New natural language intent'),
    },
    async ({ policyId, intent }) => {
      try { return ok(await protocol.revisePolicy(policyId, { intent })) }
      catch (err) { return fail(err) }
    },
  )

  // 19. trust_activate_policy
  tool(server,
    'trust_activate_policy',
    'Activate a validated policy so it can be used in escrows.',
    { policyId: z.string().describe('Policy ID') },
    async ({ policyId }) => {
      try { return ok(await protocol.activatePolicy(policyId)) }
      catch (err) { return fail(err) }
    },
  )

  // 20. trust_refine_policy
  tool(server,
    'trust_refine_policy',
    'Start adversarial refinement (Argus Codex) on a policy to find edge cases.',
    {
      policyId: z.string().describe('Policy ID'),
      budget: z.number().optional().describe('Max refinement rounds'),
    },
    async ({ policyId, budget }) => {
      try { return ok(await protocol.refinePolicy(policyId, budget !== undefined ? { budget } : undefined)) }
      catch (err) { return fail(err) }
    },
  )

  // 21. trust_refinement_status
  tool(server,
    'trust_refinement_status',
    'Check the status of an ongoing policy refinement.',
    { policyId: z.string().describe('Policy ID') },
    async ({ policyId }) => {
      try { return ok(await protocol.refinementStatus(policyId)) }
      catch (err) { return fail(err) }
    },
  )

  // 22. trust_list_marketplace
  tool(server,
    'trust_list_marketplace',
    'Browse community-shared policy templates from the marketplace. Optionally search by keyword or sort by usage/newest.',
    {
      search: z.string().optional().describe('Search keyword to filter by name or intent'),
      sort: z.enum(['usage', 'newest']).optional().describe('Sort order (default: usage)'),
    },
    async ({ search, sort }) => {
      try { return ok(await listMarketplacePolicies({ apiUrl, search, sort })) }
      catch (err) { return fail(err) }
    },
  )

  // 23. trust_use_marketplace_policy
  tool(server,
    'trust_use_marketplace_policy',
    'Clone a marketplace policy for your own use.',
    { policyId: z.string().describe('Marketplace policy ID to clone') },
    async ({ policyId }) => {
      try { return ok(await protocol.useMarketplacePolicy(policyId)) }
      catch (err) { return fail(err) }
    },
  )

  // 24. trust_query_attestations
  tool(server,
    'trust_query_attestations',
    'Query published attestations for a given agent. Returns attestations from the network.',
    {
      pubkey: z.string().describe("Agent's public key (hex) to query attestations for"),
      limit: z.number().optional().describe('Maximum number of attestations to return'),
    },
    async ({ pubkey, limit }) => {
      try {
        return ok(await queryAttestations(pubkey, { limit, apiUrl }))
      } catch (err) { return fail(err) }
    },
  )

  // 25. trust_publish_attestation
  tool(server,
    'trust_publish_attestation',
    'Publish a signed attestation about a counterparty to the Nostr relay network.',
    {
      subjectId: z.string().describe("Counterparty's public key (hex)"),
      escrowId: z.string().optional().describe('Related escrow ID'),
      outcome: z.string().describe('Transaction outcome (e.g., "success", "failure")'),
      verificationMethod: z.string().optional().describe('Verification method used'),
    },
    async (params) => {
      try { return ok(await protocol.publishAttestation(params as any)) }
      catch (err) { return fail(err) }
    },
  )

  // 26. trust_join_oracle_pool
  tool(server,
    'trust_join_oracle_pool',
    'Join the oracle pool to earn fees by verifying deliverables for other agents.',
    {
      capabilities: z.array(z.string()).optional().describe('Capabilities for task matching'),
    },
    async ({ capabilities }) => {
      try { return ok(await protocol.joinOraclePool(capabilities ? { capabilities } : undefined)) }
      catch (err) { return fail(err) }
    },
  )

  // 27. trust_withdraw_oracle_pool
  tool(server,
    'trust_withdraw_oracle_pool',
    'Withdraw from the oracle pool.',
    {},
    async () => {
      try { return ok(await protocol.withdrawFromOraclePool()) }
      catch (err) { return fail(err) }
    },
  )

  // 28. trust_oracle_status
  tool(server,
    'trust_oracle_status',
    'Check your current oracle pool status.',
    {},
    async () => {
      try { return ok(await protocol.getOracleStatus()) }
      catch (err) { return fail(err) }
    },
  )

  // 29. trust_oracle_assignments
  tool(server,
    'trust_oracle_assignments',
    'Get your pending oracle task assignments.',
    {},
    async () => {
      try { return ok(await protocol.getOracleAssignments()) }
      catch (err) { return fail(err) }
    },
  )

  // 30. trust_submit_oracle_vote
  tool(server,
    'trust_submit_oracle_vote',
    'Submit a verification vote for an oracle task.',
    {
      oracleTaskId: z.string().describe('Oracle task ID'),
      verdict: z.enum(['pass', 'fail']).describe('Verification verdict'),
      rationale: z.string().optional().describe('Explanation for the verdict'),
    },
    async (params) => {
      try { return ok(await protocol.submitOracleVote(params as any)) }
      catch (err) { return fail(err) }
    },
  )

  // 31. trust_oracle_earnings
  tool(server,
    'trust_oracle_earnings',
    'Get your accumulated oracle earnings from verifying deliverables.',
    {},
    async () => {
      try { return ok(await protocol.getOracleEarnings()) }
      catch (err) { return fail(err) }
    },
  )

  // 32. trust_get_oracle_task
  tool(server,
    'trust_get_oracle_task',
    'Get details of a specific oracle verification task.',
    { taskId: z.string().describe('Oracle task ID') },
    async ({ taskId }) => {
      try { return ok(await protocol.getOracleTask(taskId)) }
      catch (err) { return fail(err) }
    },
  )

  // 33. trust_setup_stripe_customer
  tool(server,
    'trust_setup_stripe_customer',
    'Create a Stripe Customer for buying services via escrow.',
    {},
    async () => {
      try { return ok(await protocol.setupStripeCustomer()) }
      catch (err) { return fail(err) }
    },
  )

  // 34. trust_create_setup_intent
  tool(server,
    'trust_create_setup_intent',
    'Create a Stripe SetupIntent to collect a payment method without charging. Returns a clientSecret for Stripe Elements.',
    {},
    async () => {
      try { return ok(await protocol.createSetupIntent()) }
      catch (err) { return fail(err) }
    },
  )

  // 35. trust_attach_payment_method
  tool(server,
    'trust_attach_payment_method',
    'Attach a Stripe PaymentMethod to your agent for use in escrow transactions.',
    { paymentMethodId: z.string().describe('Stripe PaymentMethod ID (pm_...)') },
    async ({ paymentMethodId }) => {
      try { return ok(await protocol.attachPaymentMethod(paymentMethodId)) }
      catch (err) { return fail(err) }
    },
  )

  // 36. trust_setup_stripe_connect
  tool(server,
    'trust_setup_stripe_connect',
    'Create a Stripe Express connected account for receiving payments as a seller. Returns an onboarding URL.',
    {
      returnUrl: z.string().optional().describe('URL to redirect after onboarding'),
      refreshUrl: z.string().optional().describe('URL to redirect if onboarding link expires'),
    },
    async ({ returnUrl, refreshUrl }) => {
      try { return ok(await protocol.setupStripeConnect({ returnUrl, refreshUrl })) }
      catch (err) { return fail(err) }
    },
  )

  // 37. trust_list_escrows
  tool(server,
    'trust_list_escrows',
    'List escrows for the current agent. Filter by status or role (buyer/seller).',
    {
      status: z.string().optional().describe('Filter by escrow status (proposed, active, released, etc.)'),
      role: z.enum(['buyer', 'seller']).optional().describe('Filter by role in the escrow'),
    },
    async ({ status, role }) => {
      try { return ok(await protocol.listEscrows({ status, role })) }
      catch (err) { return fail(err) }
    },
  )

  // 38. trust_update_agent
  tool(server,
    'trust_update_agent',
    'Update your agent profile — name, capabilities, endpoint, or metadata. Evolve your agent as your services change.',
    {
      name: z.string().optional().describe('New agent name'),
      endpoint: z.string().optional().describe('New HTTP endpoint URL'),
      capabilities: z.array(z.string()).optional().describe('Updated capability list (replaces existing)'),
      metadata: z.record(z.unknown()).optional().describe('Custom metadata object'),
    },
    async (params) => {
      try { return ok(await protocol.updateAgent(params)) }
      catch (err) { return fail(err) }
    },
  )

  // 39. trust_list_policies
  tool(server,
    'trust_list_policies',
    'List policies you have created. Filter by status (draft, validated, active, deprecated).',
    {
      status: z.string().optional().describe('Filter by policy status'),
    },
    async ({ status }) => {
      try { return ok(await protocol.listPolicies(status ? { status } : undefined)) }
      catch (err) { return fail(err) }
    },
  )

  // 40. trust_agent_stats
  tool(server,
    'trust_agent_stats',
    'Get your commerce statistics — escrow count, success rate, total value traded, unique counterparties.',
    {},
    async () => {
      try { return ok(await protocol.getStats()) }
      catch (err) { return fail(err) }
    },
  )

  // 41. trust_get_stripe_status
  tool(server,
    'trust_get_stripe_status',
    'Check Stripe onboarding status: customer setup, Connect account, and payment readiness.',
    {},
    async () => {
      try { return ok(await protocol.getStripeStatus()) }
      catch (err) { return fail(err) }
    },
  )

  return server
}
