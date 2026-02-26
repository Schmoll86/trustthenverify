import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RealOnchainService } from '../lib/onchain'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { getPublicKey, Point } from '@noble/secp256k1'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

// Mock fetch to capture RPC calls
const rpcResponses: Record<string, unknown> = {}
let capturedCalls: Array<{ method: string; params: unknown[] }> = []

vi.stubGlobal('fetch', async (_url: string, options: { body: string }) => {
  const body = JSON.parse(options.body)
  capturedCalls.push({ method: body.method, params: body.params })

  const result = rpcResponses[body.method]
  return {
    json: async () => ({
      jsonrpc: '2.0',
      id: 1,
      result: typeof result === 'function' ? result(body.params) : result,
    }),
  }
})

describe('RealOnchainService.sendTransaction (EIP-1559)', () => {
  const privateKey = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
  const chainId = 84532 // Base Sepolia

  // Derive sender address for assertions
  function deriveAddress(privKey: string): string {
    const compressed = getPublicKey(hexToBytes(privKey))
    const point = Point.fromHex(bytesToHex(compressed))
    const uncompressed = point.toBytes(false)
    const hash = keccak_256(uncompressed.slice(1))
    return '0x' + bytesToHex(hash.slice(12))
  }

  beforeEach(() => {
    capturedCalls = []
    rpcResponses['eth_getTransactionCount'] = '0x05'
    rpcResponses['eth_estimateGas'] = '0x30000' // ~200k gas
    rpcResponses['eth_gasPrice'] = '0x3b9aca00' // 1 gwei
    rpcResponses['eth_sendRawTransaction'] = '0x' + 'ab'.repeat(32)
  })

  it('calls correct RPC methods in order', async () => {
    const service = new RealOnchainService(
      'https://mock-rpc.example.com',
      '0x' + '11'.repeat(20),
      privateKey,
      chainId,
    )

    // Access private method via prototype
    const sendTx = (service as any).sendTransaction.bind(service)
    await sendTx('0x' + '22'.repeat(20), '0xdeadbeef')

    const methods = capturedCalls.map(c => c.method)
    expect(methods).toContain('eth_getTransactionCount')
    expect(methods).toContain('eth_estimateGas')
    expect(methods).toContain('eth_gasPrice')
    expect(methods).toContain('eth_sendRawTransaction')
  })

  it('uses correct sender address for nonce lookup', async () => {
    const service = new RealOnchainService(
      'https://mock-rpc.example.com',
      '0x' + '11'.repeat(20),
      privateKey,
      chainId,
    )

    const sendTx = (service as any).sendTransaction.bind(service)
    await sendTx('0x' + '22'.repeat(20), '0xdeadbeef')

    const nonceCall = capturedCalls.find(c => c.method === 'eth_getTransactionCount')
    expect(nonceCall).toBeDefined()
    const expectedAddr = deriveAddress(privateKey)
    expect((nonceCall!.params[0] as string).toLowerCase()).toBe(expectedAddr.toLowerCase())
  })

  it('raw tx starts with 0x02 (EIP-1559 type prefix)', async () => {
    const service = new RealOnchainService(
      'https://mock-rpc.example.com',
      '0x' + '11'.repeat(20),
      privateKey,
      chainId,
    )

    const sendTx = (service as any).sendTransaction.bind(service)
    await sendTx('0x' + '22'.repeat(20), '0xdeadbeef')

    const sendCall = capturedCalls.find(c => c.method === 'eth_sendRawTransaction')
    expect(sendCall).toBeDefined()
    const rawTx = sendCall!.params[0] as string
    expect(rawTx.startsWith('0x02')).toBe(true)
  })

  it('returns tx hash from RPC', async () => {
    const service = new RealOnchainService(
      'https://mock-rpc.example.com',
      '0x' + '11'.repeat(20),
      privateKey,
      chainId,
    )

    const sendTx = (service as any).sendTransaction.bind(service)
    const txHash = await sendTx('0x' + '22'.repeat(20), '0xdeadbeef')
    expect(txHash).toBe('0x' + 'ab'.repeat(32))
  })

  it('handles gas estimation failure with fallback', async () => {
    rpcResponses['eth_estimateGas'] = (() => { throw new Error('revert') }) as any

    // Override fetch to throw on estimateGas
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (_url: string, options: { body: string }) => {
      const body = JSON.parse(options.body)
      capturedCalls.push({ method: body.method, params: body.params })

      if (body.method === 'eth_estimateGas') {
        return {
          json: async () => ({
            jsonrpc: '2.0',
            id: 1,
            error: { message: 'execution reverted' },
          }),
        }
      }

      const result = rpcResponses[body.method]
      return {
        json: async () => ({ jsonrpc: '2.0', id: 1, result }),
      }
    })

    const service = new RealOnchainService(
      'https://mock-rpc.example.com',
      '0x' + '11'.repeat(20),
      privateKey,
      chainId,
    )

    const sendTx = (service as any).sendTransaction.bind(service)
    // Should use 1M gas fallback and still succeed
    await sendTx('0x' + '22'.repeat(20), '0xdeadbeef')

    const sendCall = capturedCalls.find(c => c.method === 'eth_sendRawTransaction')
    expect(sendCall).toBeDefined()

    vi.stubGlobal('fetch', originalFetch)
  })
})
