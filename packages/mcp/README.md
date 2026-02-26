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
        "TRUST_API_URL": "https://sandbox.trustthenverify.com/v2",
        "TRUST_SANDBOX_KEY": "your-sandbox-key"
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
        "TRUST_API_URL": "https://sandbox.trustthenverify.com/v2",
        "TRUST_SANDBOX_KEY": "..."
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
| `TRUST_SANDBOX_KEY` | No | Sandbox API key for sandbox mode |

## Tools (28)

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

### Agent Management
| Tool | Description |
|------|-------------|
| `trust_spawn_agent` | Register a child agent |

## License

MIT
