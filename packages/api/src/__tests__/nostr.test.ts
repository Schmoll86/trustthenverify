import { describe, it, expect } from 'vitest'
import { buildAttestationEvent } from '../lib/nostr'
import { generateKeypair } from '@trustthenverify/sdk'

// Use a fixed private key for deterministic tests
// (Schnorr x-only pubkey derived from same bytes)
const GATEWAY_PRIVATE_KEY = generateKeypair().privateKey

describe('buildAttestationEvent', () => {
  const baseContent = {
    subjectPubkey: 'ab'.repeat(32),
    outcome: 'success',
    escrowId: 'escrow-123',
    verificationMethod: 'automated_reasoning',
    authorId: 'author-agent-id',
    timestamp: '2025-01-15T12:00:00.000Z',
  }

  it('produces valid NIP-01 event structure', async () => {
    const event = await buildAttestationEvent(baseContent, GATEWAY_PRIVATE_KEY)

    expect(event).toHaveProperty('id')
    expect(event).toHaveProperty('pubkey')
    expect(event).toHaveProperty('created_at')
    expect(event).toHaveProperty('kind')
    expect(event).toHaveProperty('tags')
    expect(event).toHaveProperty('content')
    expect(event).toHaveProperty('sig')
  })

  it('uses kind 30078 (NIP-78 application-specific data)', async () => {
    const event = await buildAttestationEvent(baseContent, GATEWAY_PRIVATE_KEY)
    expect(event.kind).toBe(30078)
  })

  it('event id is 64-char hex (SHA-256 of serialized array)', async () => {
    const event = await buildAttestationEvent(baseContent, GATEWAY_PRIVATE_KEY)
    expect(event.id).toMatch(/^[0-9a-f]{64}$/)

    // Verify id is SHA-256 of [0, pubkey, created_at, kind, tags, content]
    const { sha256 } = await import('@noble/hashes/sha2.js')
    const { bytesToHex, utf8ToBytes } = await import('@noble/hashes/utils.js')
    const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])
    const expectedId = bytesToHex(sha256(utf8ToBytes(serialized)))
    expect(event.id).toBe(expectedId)
  })

  it('event pubkey is 64-char hex (32-byte x-only)', async () => {
    const event = await buildAttestationEvent(baseContent, GATEWAY_PRIVATE_KEY)
    expect(event.pubkey).toMatch(/^[0-9a-f]{64}$/)
  })

  it('signature verifies with schnorr.verify()', async () => {
    const event = await buildAttestationEvent(baseContent, GATEWAY_PRIVATE_KEY)
    const { schnorr } = await import('@noble/secp256k1')
    const { hexToBytes } = await import('@noble/hashes/utils.js')

    const valid = schnorr.verify(
      hexToBytes(event.sig),
      hexToBytes(event.id),
      hexToBytes(event.pubkey),
    )
    expect(valid).toBe(true)
  })

  it('tags include d, subject, and outcome', async () => {
    const event = await buildAttestationEvent(baseContent, GATEWAY_PRIVATE_KEY)

    const tagMap = new Map(event.tags.map((t) => [t[0], t[1]]))
    expect(tagMap.get('d')).toBe('ttv_attestation')
    expect(tagMap.get('subject')).toBe(baseContent.subjectPubkey)
    expect(tagMap.get('outcome')).toBe('success')
  })

  it('content is valid JSON matching protocol format', async () => {
    const event = await buildAttestationEvent(baseContent, GATEWAY_PRIVATE_KEY)
    const parsed = JSON.parse(event.content)

    expect(parsed.protocol).toBe('trustthenverify')
    expect(parsed.version).toBe(2)
    expect(parsed.authorId).toBe(baseContent.authorId)
    expect(parsed.subjectPubkey).toBe(baseContent.subjectPubkey)
    expect(parsed.outcome).toBe('success')
    expect(parsed.escrowId).toBe('escrow-123')
    expect(parsed.verificationMethod).toBe('automated_reasoning')
    expect(parsed.timestamp).toBe(baseContent.timestamp)
  })

  it('handles null optional fields', async () => {
    const event = await buildAttestationEvent(
      { ...baseContent, escrowId: null, verificationMethod: null },
      GATEWAY_PRIVATE_KEY,
    )
    const parsed = JSON.parse(event.content)
    expect(parsed.escrowId).toBeNull()
    expect(parsed.verificationMethod).toBeNull()
  })
})
