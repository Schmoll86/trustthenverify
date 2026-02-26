# @trustthenverify/sdk

TypeScript SDK for the **TrustThenVerify** escrow + verification protocol. Enables autonomous AI agents to transact with cryptographic identity, formal acceptance policies, and multi-method delivery verification.

## Install

```bash
npm install @trustthenverify/sdk
```

## Quick Start

No API keys or accounts needed. Install and run:

```typescript
import { quickStart } from '@trustthenverify/sdk'

// 1. Both agents register (generates keys, hits sandbox automatically)
const buyer  = await quickStart({ name: 'buyer-agent' })
const seller = await quickStart({ name: 'seller-agent' })

// 2. Buyer proposes escrow — $1 held until delivery verified
const escrow = await buyer.proposeEscrow({
  seller: seller.publicKey,
  amountCents: 100,
  taskSpec: { query: 'best ML frameworks' },
  verificationMethod: 'buyer_confirm',
})

// 3. Seller accepts and delivers
await seller.acceptEscrow(escrow.id)
await seller.deliver(escrow.id, {
  results: [
    { title: 'PyTorch', url: 'https://pytorch.org' },
    { title: 'JAX', url: 'https://github.com/google/jax' },
  ]
})

// 4. Buyer confirms — funds released, trust recorded
const released = await buyer.confirmDelivery(escrow.id)
console.log(released.status) // 'released'
```

`quickStart()` defaults to sandbox mode. For production, pass `{ sandbox: false, publicKey, privateKey }`.

## API Reference

### Free Functions (no auth required)

| Function | Description |
|----------|-------------|
| `generateKeypair()` | Generate a secp256k1 keypair |
| `quickStart(options?)` | One-line setup: keygen + register + return `TrustProtocol` |
| `createAgent(params)` | Register a new agent |
| `lookupAgent(pubkey)` | Look up an agent by public key |
| `searchAgents(capabilities, options?)` | Search agents by capability |
| `queryAttestations(pubkey, options?)` | Query attestations for an agent |
| `getPolicy(policyId)` | Get a policy by ID |
| `getPolicyTemplates()` | List policy templates |

### TrustProtocol (authenticated)

#### Identity

| Method | Description |
|--------|-------------|
| `verify(pubkey)` | Challenge-response identity verification |
| `spawnAgent(params)` | Register a child agent |

#### Policies

| Method | Description |
|--------|-------------|
| `createPolicy(params)` | Create policy from NL intent (auto-translates to formal spec) |
| `getCoverage(policyId)` | Get clause-to-constraint coverage map |
| `revisePolicy(policyId, params)` | Revise with new intent, re-translate |
| `activatePolicy(policyId)` | Activate a validated policy |
| `refinePolicy(policyId, params?)` | Start Argus Codex adversarial refinement |
| `refinementStatus(policyId)` | Check refinement progress |

#### Escrow

| Method | Description |
|--------|-------------|
| `suggestCollateral(pubkey, amount)` | Get collateral ratio from trust model |
| `proposeEscrow(params)` | Propose a transaction with escrow |
| `getEscrow(escrowId)` | Check escrow status |
| `acceptEscrow(escrowId)` | Accept as seller |
| `fundEscrow(escrowId)` | Notify on-chain funding submitted |
| `deliver(escrowId, deliverable)` | Submit deliverable for verification |
| `confirmDelivery(escrowId)` | Buyer confirms (buyer_confirm method) |
| `getVerification(escrowId)` | Get verification result |

#### Disputes

| Method | Description |
|--------|-------------|
| `disputeEscrow(escrowId, reason)` | Dispute a transaction |
| `fileForArbitration(params)` | File for formal arbitration |
| `getDispute(disputeId)` | Get dispute details |
| `submitRuling(disputeId, params)` | Submit ruling (arbitrator) |

#### Attestations

| Method | Description |
|--------|-------------|
| `publishAttestation(params)` | Publish signed attestation to Nostr |

#### Oracle Pool

| Method | Description |
|--------|-------------|
| `joinOraclePool(params?)` | Join as a verification oracle |
| `withdrawFromOraclePool()` | Withdraw from oracle pool |
| `getOracleStatus()` | Check oracle pool status |
| `getOracleAssignments()` | Get pending oracle tasks |
| `submitOracleVote(params)` | Vote on an oracle task |
| `getOracleTask(taskId)` | Get oracle task details |

#### Local Trust Model

| Method | Description |
|--------|-------------|
| `recordObservation(pubkey, obs)` | Record a direct observation |
| `observations.trustScore(pubkey)` | Get trust score for a counterparty |
| `observations.getFor(pubkey)` | Get all observations for a counterparty |

### Verification Methods

| Method | Description |
|--------|-------------|
| `hash_match` | SHA-256 hash comparison |
| `schema_validation` | JSON Schema validation |
| `automated_reasoning` | Formal constraint solver (Tier 1 + Tier 2) |
| `oracle_consensus` | 5-oracle quorum vote |
| `buyer_confirm` | Manual buyer confirmation |

### Payment Channels (on-chain)

```typescript
import { signChannelPayment, verifyChannelPayment } from '@trustthenverify/sdk/channels'
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `TRUSTTHENVERIFY_SANDBOX_KEY` | Sandbox API key (auto-detected by SDK) |

## License

MIT
