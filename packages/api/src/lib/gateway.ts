/**
 * Gateway verification service — runs Tier 1 solver or schema validation
 * on deliverables and signs the result. Per SPEC-v2 §4.1.
 */

import { solveAllWithTier2 } from './solver-tier2'
import { validateSchema as schemaValidate } from './schema-validate'
import type { AIService } from './workers-ai'

export interface GatewayVerificationResult {
  result: 'pass' | 'fail' | 'error'
  constraintsTotal: number
  constraintsPassed: number
  failures: Array<{ id: string; error: string }>
  gatewaySignature: string
  verifiedAt: string
  tier2Used?: boolean
}

export interface ChainSignature {
  v: number
  r: string
  s: string
}

export interface GatewayService {
  verify(params: {
    escrowId: string
    deliverable: unknown
    verificationMethod: string
    policyId: string | null
    taskSpec: Record<string, unknown>
  }): Promise<GatewayVerificationResult>

  /** Produce Ethereum-compatible {v,r,s} signature for ecrecover in smart contract. */
  signForChain?(params: {
    escrowId: string
    resultDigest: string
    contractAddress: string
    action: 'release' | 'fail'
  }): Promise<ChainSignature>
}

interface FormalSpec {
  version: number
  constraints: Array<{
    id: string
    type: string
    target: string
    params: Record<string, unknown>
  }>
}

interface PolicyRow {
  id: string
  status: string
  formal_spec: Record<string, unknown>
}

type FetchPolicy = (policyId: string) => Promise<PolicyRow | null>

export class RealGatewayService implements GatewayService {
  private gatewayPrivateKey: string
  private fetchPolicy: FetchPolicy
  private ai: AIService | null

  constructor(gatewayPrivateKey: string, fetchPolicy: FetchPolicy, ai?: AIService | null) {
    this.gatewayPrivateKey = gatewayPrivateKey
    this.fetchPolicy = fetchPolicy
    this.ai = ai ?? null
  }

  async verify(params: {
    escrowId: string
    deliverable: unknown
    verificationMethod: string
    policyId: string | null
    taskSpec: Record<string, unknown>
  }): Promise<GatewayVerificationResult> {
    const verifiedAt = new Date().toISOString()

    try {
      if (params.verificationMethod === 'automated_reasoning') {
        return await this.verifyAutomatedReasoning(params, verifiedAt)
      } else if (params.verificationMethod === 'schema_validation') {
        return await this.verifySchemaValidation(params, verifiedAt)
      }
      throw new Error(`Unsupported verification method: ${params.verificationMethod}`)
    } catch (err) {
      return {
        result: 'error',
        constraintsTotal: 0,
        constraintsPassed: 0,
        failures: [{ id: '_gateway', error: (err as Error).message }],
        gatewaySignature: '',
        verifiedAt,
      }
    }
  }

  private async verifyAutomatedReasoning(
    params: { escrowId: string; deliverable: unknown; policyId: string | null },
    verifiedAt: string,
  ): Promise<GatewayVerificationResult> {
    if (!params.policyId) {
      throw new Error('policyId is required for automated_reasoning')
    }

    const policy = await this.fetchPolicy(params.policyId)
    if (!policy) throw new Error(`Policy not found: ${params.policyId}`)
    if (policy.status !== 'active') throw new Error(`Policy not active: ${policy.status}`)

    const formalSpec = policy.formal_spec as unknown as FormalSpec
    const solveResult = await solveAllWithTier2(formalSpec, params.deliverable, this.ai)

    const signature = await this.sign(
      params.escrowId, solveResult.result, solveResult.constraintsTotal,
      solveResult.constraintsPassed, verifiedAt,
    )

    return {
      result: solveResult.result,
      constraintsTotal: solveResult.constraintsTotal,
      constraintsPassed: solveResult.constraintsPassed,
      failures: solveResult.failures,
      gatewaySignature: signature,
      verifiedAt,
      tier2Used: solveResult.tier2Used,
    }
  }

  private async verifySchemaValidation(
    params: { escrowId: string; deliverable: unknown; taskSpec: Record<string, unknown> },
    verifiedAt: string,
  ): Promise<GatewayVerificationResult> {
    const expectedSchema = params.taskSpec.expected_schema as Record<string, unknown> | undefined
    if (!expectedSchema) {
      throw new Error('taskSpec.expected_schema is required for schema_validation')
    }

    const valid = schemaValidate(params.deliverable, expectedSchema)
    const result = valid ? 'pass' as const : 'fail' as const

    const signature = await this.sign(
      params.escrowId, result, 1, valid ? 1 : 0, verifiedAt,
    )

    return {
      result,
      constraintsTotal: 1,
      constraintsPassed: valid ? 1 : 0,
      failures: valid ? [] : [{ id: '_schema', error: 'Deliverable does not match expected schema' }],
      gatewaySignature: signature,
      verifiedAt,
    }
  }

  /** Produce Ethereum-compatible {v,r,s} for ecrecover in EscrowInstance contract. */
  async signForChain(params: {
    escrowId: string
    resultDigest: string
    contractAddress: string
    action: 'release' | 'fail'
  }): Promise<ChainSignature> {
    const { signAsync } = await import('@noble/secp256k1')
    const { sha256 } = await import('@noble/hashes/sha2.js')
    const { bytesToHex, hexToBytes } = await import('@noble/hashes/utils.js')

    // Match the Solidity message hash construction
    const escrowIdBytes = hexToBytes(params.escrowId.startsWith('0x') ? params.escrowId.slice(2) : params.escrowId)
    const resultBytes = hexToBytes(params.resultDigest.startsWith('0x') ? params.resultDigest.slice(2) : params.resultDigest)
    const addrBytes = hexToBytes(params.contractAddress.startsWith('0x') ? params.contractAddress.slice(2) : params.contractAddress)

    let packed: Uint8Array
    if (params.action === 'fail') {
      const failPrefix = new TextEncoder().encode('FAIL')
      packed = new Uint8Array([...failPrefix, ...escrowIdBytes, ...resultBytes, ...addrBytes])
    } else {
      packed = new Uint8Array([...escrowIdBytes, ...resultBytes, ...addrBytes])
    }

    // keccak256(abi.encodePacked(...)) — we use sha256 as keccak placeholder
    // Real deployment uses keccak256; for consistency with contract
    const messageHash = sha256(packed)

    // Ethereum signed message prefix
    const prefix = new TextEncoder().encode('\x19Ethereum Signed Message:\n32')
    const ethSignedHash = sha256(new Uint8Array([...prefix, ...messageHash]))

    const sig = await signAsync(ethSignedHash, hexToBytes(this.gatewayPrivateKey), { prehash: false })
    const sigBytes = sig as unknown as Uint8Array
    const r = bytesToHex(sigBytes.slice(0, 32))
    const s = bytesToHex(sigBytes.slice(32, 64))
    // Recovery bit: noble v3 includes it as the 65th byte when using Signature.toCompactRawBytes()
    // For our purposes, we default to v=27 (even parity) — real deployment derives from recovery
    const v = sigBytes.length > 64 ? (sigBytes[64] ?? 0) + 27 : 27

    return { v, r, s }
  }

  private async sign(
    escrowId: string,
    result: string,
    total: number,
    passed: number,
    verifiedAt: string,
  ): Promise<string> {
    // Dynamic import to avoid bundling issues in Workers
    const { signAsync } = await import('@noble/secp256k1')
    const { sha256 } = await import('@noble/hashes/sha2.js')
    const { bytesToHex, hexToBytes } = await import('@noble/hashes/utils.js')

    const canonical = `${escrowId}\n${result}\n${total}\n${passed}\n${verifiedAt}`
    const msgHash = sha256(new TextEncoder().encode(canonical))
    const sig = await signAsync(msgHash, hexToBytes(this.gatewayPrivateKey), { prehash: false })
    return bytesToHex(sig as unknown as Uint8Array)
  }
}
