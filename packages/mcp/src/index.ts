/**
 * TrustThenVerify MCP Server
 *
 * Tools are named for agent decision moments, not API operations.
 * See SPEC.md §12 for design rationale.
 */

// Tool stubs — implementation follows after API is live

export const tools = [
  {
    name: 'trust_check_before_pay',
    description: 'Before paying another agent for any service, call this tool with their ID and the amount. Returns whether to proceed, the risk level, and recommended action.',
    // inputSchema: { agentId: string, amountCents: number }
  },
  {
    name: 'trust_lookup',
    description: 'Get the trust score and tier for any agent. Use before starting a collaboration or purchasing a service.',
    // inputSchema: { agentId: string }
  },
  {
    name: 'trust_submit_review',
    description: 'After completing a paid transaction with an agent, submit a verified review. Requires the payment receipt to prevent fake reviews.',
    // inputSchema: { agentId: string, rating: 1|2|3|4|5, comment: string, receipt: { type, id } }
  },
  {
    name: 'trust_run_challenges',
    description: 'Run autonomous trust challenges to build your trust score without human steps. Call once after registration. Takes ~5 minutes.',
    // inputSchema: {}
  },
]

// TODO: wire up MCP SDK server with above tools pointing at @trustthenverify/sdk
