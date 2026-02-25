import { describe, it, expect } from 'vitest'
import {
  generateKeypair,
  sha256Hex,
  buildCanonicalString,
  signRequest,
  verifySignature,
} from '../crypto'

describe('generateKeypair', () => {
  it('returns a valid keypair with 66-char compressed pubkey', () => {
    const kp = generateKeypair()
    expect(kp.privateKey).toMatch(/^[0-9a-f]{64}$/)
    expect(kp.publicKey).toMatch(/^[0-9a-f]{66}$/)
    // Compressed pubkey starts with 02 or 03
    expect(['02', '03']).toContain(kp.publicKey.slice(0, 2))
  })

  it('generates unique keypairs', () => {
    const kp1 = generateKeypair()
    const kp2 = generateKeypair()
    expect(kp1.privateKey).not.toBe(kp2.privateKey)
    expect(kp1.publicKey).not.toBe(kp2.publicKey)
  })
})

describe('sha256Hex', () => {
  it('produces correct hash for empty string', () => {
    const hash = sha256Hex('')
    expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('produces correct hash for known input', () => {
    const hash = sha256Hex('hello')
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })
})

describe('buildCanonicalString', () => {
  it('builds canonical string per §9.2 format', () => {
    const canonical = buildCanonicalString('POST', '/agents', '{"publicKey":"abc"}', 1700000000)
    const bodyHash = sha256Hex('{"publicKey":"abc"}')
    expect(canonical).toBe(`1700000000\nPOST\n/agents\n${bodyHash}`)
  })

  it('handles empty body', () => {
    const canonical = buildCanonicalString('GET', '/agents/abc', '', 1700000000)
    const emptyHash = sha256Hex('')
    expect(canonical).toBe(`1700000000\nGET\n/agents/abc\n${emptyHash}`)
  })
})

describe('signRequest + verifySignature', () => {
  it('round-trips correctly', async () => {
    const kp = generateKeypair()
    const method = 'POST'
    const path = '/agents'
    const body = '{"publicKey":"test"}'
    const timestamp = Math.floor(Date.now() / 1000)

    const signature = await signRequest(kp.privateKey, method, path, body, timestamp)
    expect(signature).toMatch(/^[0-9a-f]+$/)

    const valid = await verifySignature(kp.publicKey, signature, method, path, body, timestamp)
    expect(valid).toBe(true)
  })

  it('detects tampered body', async () => {
    const kp = generateKeypair()
    const timestamp = Math.floor(Date.now() / 1000)

    const signature = await signRequest(kp.privateKey, 'POST', '/agents', '{"original":true}', timestamp)
    const valid = await verifySignature(kp.publicKey, signature, 'POST', '/agents', '{"tampered":true}', timestamp)
    expect(valid).toBe(false)
  })

  it('detects wrong public key', async () => {
    const kp1 = generateKeypair()
    const kp2 = generateKeypair()
    const timestamp = Math.floor(Date.now() / 1000)

    const signature = await signRequest(kp1.privateKey, 'POST', '/agents', '{}', timestamp)
    const valid = await verifySignature(kp2.publicKey, signature, 'POST', '/agents', '{}', timestamp)
    expect(valid).toBe(false)
  })

  it('detects wrong timestamp', async () => {
    const kp = generateKeypair()

    const signature = await signRequest(kp.privateKey, 'POST', '/agents', '{}', 1700000000)
    const valid = await verifySignature(kp.publicKey, signature, 'POST', '/agents', '{}', 1700000001)
    expect(valid).toBe(false)
  })

  it('works with empty body', async () => {
    const kp = generateKeypair()
    const timestamp = Math.floor(Date.now() / 1000)

    const signature = await signRequest(kp.privateKey, 'GET', '/agents/search', '', timestamp)
    const valid = await verifySignature(kp.publicKey, signature, 'GET', '/agents/search', '', timestamp)
    expect(valid).toBe(true)
  })
})
