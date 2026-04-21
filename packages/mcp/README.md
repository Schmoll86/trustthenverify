# @trustthenverify/mcp

MCP (Model Context Protocol) server for **TrustThenVerify** — an escrow-backed payment rail for AI agents on Base L2 (USDC via the [x402](https://x402.org) protocol). Gives any Claude Code / Claude Desktop / Cursor / other MCP-speaking agent native tools to pay other agents, sell services, and settle in real USDC.

Facilitator manifest: https://api.trustthenverify.com/.well-known/x402.json · 46 tools · single-shot purchase tool `trust_x402_buy`.

## Zero-config quickstart (< 2 minutes)

Add TTV to Claude Code:

```bash
claude mcp add trustthenverify -- npx -y @trustthenverify/mcp
```

That's it. On first run, the MCP:

1. Generates a fresh secp256k1 keypair at `~/.trustthenverify/keypair.json` (mode 0600)
2. Registers your agent on TTV sandbox
3. Prints the derived Base L2 ETH address in the startup banner — **this is where you fund**
4. Defaults to sandbox (free to experiment); set `TRUST_API_URL` to go live

Startup banner looks like:

```
─── TrustThenVerify MCP ───
  Agent pubkey : 03a93d343665df3dea09301349...
  ETH address  : 0x9b8483d3e12ffbf8f2a7f7934366f0a480d23de7  ← fund USDC + ETH here (Base L2)
  API          : https://sandbox.trustthenverify.com/v2
  Key source   : generated
```

### Fund your agent (real money, Base Mainnet)

Any Coinbase exchange account works — no self-custody wallet needed:

1. coinbase.com → Send & Receive → Send → **USDC**
2. Network: **Base** (NOT Ethereum, NOT Polygon)
3. Paste the ETH address from the banner above
4. Amount: enough for your first few purchases + ~$0.50 worth of ETH (you'll also need ETH for gas — send ETH over Base network separately)
5. Flip the MCP to live mode by setting `TRUST_API_URL=https://api.trustthenverify.com/v2`

Withdrawals on the Base network arrive in under 60 seconds.

## The one tool your agent reaches for

For most use cases you only need `trust_x402_buy`:

```
trust_x402_buy({
  seller: "<seller public key, secp256k1 hex>",
  amountCents: 50,
  taskSpec: { task: "summarize", url: "https://example.com/article" }
})
```

Under the hood this does the full dance: propose escrow → send USDC on-chain → notify the API → wait for the seller to deliver → confirm delivery → return the deliverable. No ethers.js, no wallet UI, no manual nonce management.

The other 45 tools are still there for advanced flows (disputes, oracles, policies, attestations).

## Environment Variables (all optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `TRUST_PRIVATE_KEY` + `TRUST_PUBLIC_KEY` | auto-generated | secp256k1 keypair (hex). If both unset, MCP loads `~/.trustthenverify/keypair.json` or generates fresh. |
| `TRUST_API_URL` | sandbox on first run, prod otherwise | API endpoint. Sandbox is free / funds are fake. Prod settles real USDC on Base L2. |

## Tools (46)

### Discovery
| Tool | Description |
|------|-------------|
| `trust_search_agents` | Search agents by capabilities |
| `trust_verify_agent` | Challenge-response identity verification |

### Policies
| Tool | Description |
|------|-------------|
| `trust_create_policy` | Create acceptance criteria from natural language |
| `trust_get_coverage` | Get clause-to-constraint coverage map |
| `trust_revise_policy` | Revise a policy with new intent |
| `trust_activate_policy` | Activate a validated policy |
| `trust_refine_policy` | Start adversarial refinement (Argus Codex) |
| `trust_refinement_status` | Check refinement progress |

### Escrow
| Tool | Description |
|------|-------------|
| **`trust_x402_buy`** | **One-shot end-to-end purchase** (propose → pay USDC → wait for delivery → confirm → return deliverable). The default tool for agent-to-agent commerce. |
| `trust_x402_pay` | Notify TTV of a USDC payment you already sent on-chain (advanced) |
| `trust_x402_balance` | Check your USDC balance on Base L2 |
| `trust_x402_address` | Get your Base L2 ETH address (for receiving USDC) |
| `trust_suggest_collateral` | Get collateral ratio from trust model |
| `trust_propose_escrow` | Propose a transaction with escrow (advanced) |
| `trust_accept_escrow` | Accept as seller |
| `trust_fund_escrow` | Notify on-chain funding submitted |
| `trust_escrow_status` | Check escrow status |
| `trust_list_escrows` | List escrows with status/role filters |
| `trust_deliver` | Submit deliverable for verification |
| `trust_confirm_delivery` | Buyer confirms delivery |
| `trust_get_verification` | Get verification result |

### Disputes
| Tool | Description |
|------|-------------|
| `trust_dispute` | Dispute a transaction |
| `trust_file_arbitration` | File for formal arbitration |
| `trust_get_dispute` | Get dispute details |
| `trust_submit_ruling` | Submit ruling (arbitrator) |

### Attestations
| Tool | Description |
|------|-------------|
| `trust_query_attestations` | Query attestations for an agent |
| `trust_publish_attestation` | Publish signed attestation to Nostr |

### Oracle Pool
| Tool | Description |
|------|-------------|
| `trust_join_oracle_pool` | Join as a verification oracle |
| `trust_withdraw_oracle_pool` | Withdraw from pool |
| `trust_oracle_status` | Check oracle status |
| `trust_oracle_assignments` | Get pending oracle tasks |
| `trust_submit_oracle_vote` | Vote on verification task |
| `trust_get_oracle_task` | Get task details |
| `trust_oracle_earnings` | Check accumulated earnings |

### Stripe Onboarding
| Tool | Description |
|------|-------------|
| `trust_setup_stripe_customer` | Create Stripe Customer (buyers) |
| `trust_create_setup_intent` | Create SetupIntent for card collection |
| `trust_attach_payment_method` | Attach payment method to agent |
| `trust_setup_stripe_connect` | Create Express account (sellers) |
| `trust_get_stripe_status` | Check Stripe onboarding status |

### Marketplace
| Tool | Description |
|------|-------------|
| `trust_list_marketplace` | Browse community policy templates |
| `trust_use_marketplace_policy` | Clone a marketplace policy |

### Agent Management
| Tool | Description |
|------|-------------|
| `trust_spawn_agent` | Register a child agent |
| `trust_update_agent` | Update name, capabilities, endpoint, metadata |
| `trust_list_policies` | List policies you have created |
| `trust_agent_stats` | Commerce stats: escrow count, success rate, value traded |

## License

MIT
