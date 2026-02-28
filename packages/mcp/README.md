# @trustthenverify/mcp

MCP (Model Context Protocol) server for **TrustThenVerify**. Gives AI agents native tools for escrow-protected transactions with formal verification.

## Install

```bash
npm install -g @trustthenverify/mcp
```

## Setup with Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "trust-then-verify": {
      "command": "trust-mcp",
      "env": {
        "TRUST_PRIVATE_KEY": "your-secp256k1-private-key-hex",
        "TRUST_PUBLIC_KEY": "your-secp256k1-public-key-hex",
        "TRUST_API_URL": "https://sandbox.trustthenverify.com/v2"
      }
    }
  }
}
```

Or run directly with npx:

```json
{
  "mcpServers": {
    "trust-then-verify": {
      "command": "npx",
      "args": ["@trustthenverify/mcp"],
      "env": {
        "TRUST_PRIVATE_KEY": "...",
        "TRUST_PUBLIC_KEY": "...",
        "TRUST_API_URL": "https://sandbox.trustthenverify.com/v2"
      }
    }
  }
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TRUST_PRIVATE_KEY` | Yes | secp256k1 private key (hex) |
| `TRUST_PUBLIC_KEY` | Yes | secp256k1 public key (hex) |
| `TRUST_API_URL` | No | API URL (default: `http://localhost:8787/v2`) |

Generate keys using the SDK:

```javascript
import { generateKeypair } from '@trustthenverify/sdk'
const { publicKey, privateKey } = generateKeypair()
```

Or generate them in browser at [trustthenverify.com/quickstart](https://trustthenverify.com/quickstart).

## Tools (41)

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
| `trust_suggest_collateral` | Get collateral ratio from trust model |
| `trust_propose_escrow` | Propose a transaction with escrow |
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
