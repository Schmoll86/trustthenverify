import { describe, it, expect } from 'vitest'
import { RealGatewayService } from '../lib/gateway'
import { generateKeypair, sha256Hex } from '@trustthenverify/sdk'

const gatewayKp = generateKeypair()

// No policy needed for hash_match — pass null fetchPolicy
const gateway = new RealGatewayService(
  gatewayKp.privateKey,
  async () => null,
)

describe('RealGatewayService: hash_match', () => {
  it('pass when deliverable hash matches expected_hash', async () => {
    const deliverable = { result: 42, metadata: { computed: true } }
    const expectedHash = sha256Hex(JSON.stringify(deliverable))

    const result = await gateway.verify({
      escrowId: 'test-escrow-1',
      deliverable,
      verificationMethod: 'hash_match',
      policyId: null,
      taskSpec: { expected_hash: expectedHash },
    })

    expect(result.result).toBe('pass')
    expect(result.constraintsTotal).toBe(1)
    expect(result.constraintsPassed).toBe(1)
    expect(result.failures).toHaveLength(0)
    expect(result.gatewaySignature).toBeTruthy()
  })

  it('fail when deliverable hash does not match', async () => {
    const deliverable = { result: 42 }

    const result = await gateway.verify({
      escrowId: 'test-escrow-2',
      deliverable,
      verificationMethod: 'hash_match',
      policyId: null,
      taskSpec: { expected_hash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
    })

    expect(result.result).toBe('fail')
    expect(result.constraintsTotal).toBe(1)
    expect(result.constraintsPassed).toBe(0)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].id).toBe('_hash_match')
    expect(result.failures[0].error).toContain('Hash mismatch')
  })

  it('error when expected_hash missing from taskSpec', async () => {
    const result = await gateway.verify({
      escrowId: 'test-escrow-3',
      deliverable: { data: 'test' },
      verificationMethod: 'hash_match',
      policyId: null,
      taskSpec: { type: 'compute' },
    })

    expect(result.result).toBe('error')
    expect(result.failures[0].error).toContain('expected_hash is required')
  })

  it('case-insensitive hash comparison', async () => {
    const deliverable = { value: 'hello' }
    const expectedHash = sha256Hex(JSON.stringify(deliverable)).toUpperCase()

    const result = await gateway.verify({
      escrowId: 'test-escrow-4',
      deliverable,
      verificationMethod: 'hash_match',
      policyId: null,
      taskSpec: { expected_hash: expectedHash },
    })

    expect(result.result).toBe('pass')
  })
})
