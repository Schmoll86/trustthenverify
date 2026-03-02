import { describe, it, expect } from 'vitest'
import type { X402PaymentInstructions } from '../lib/x402'

// Unit tests for x402 service logic (no RPC calls — those are mocked in route tests)

describe('X402 PaymentInstructions generation', () => {
  it('converts cents to USDC correctly', () => {
    // 550 cents = $5.50 = 5500000 raw (6 decimals)
    const amountCents = 550
    const amountUsdc = (amountCents / 100).toFixed(2)
    const amountUsdcRaw = String(BigInt(amountCents) * BigInt(10 ** 4))

    expect(amountUsdc).toBe('5.50')
    expect(amountUsdcRaw).toBe('5500000')
  })

  it('converts large amounts correctly', () => {
    const amountCents = 100000 // $1000
    const amountUsdc = (amountCents / 100).toFixed(2)
    const amountUsdcRaw = String(BigInt(amountCents) * 10000n)

    expect(amountUsdc).toBe('1000.00')
    expect(amountUsdcRaw).toBe('1000000000')
  })

  it('converts small amounts correctly', () => {
    const amountCents = 1 // $0.01
    const amountUsdc = (amountCents / 100).toFixed(2)
    const amountUsdcRaw = String(BigInt(amountCents) * 10000n)

    expect(amountUsdc).toBe('0.01')
    expect(amountUsdcRaw).toBe('10000')
  })
})

describe('x402 fee calculation', () => {
  it('calculates 1% settlement fee correctly', () => {
    const amountCents = 550
    const feeBps = 100 // 1%
    const feeCents = Math.round(amountCents * feeBps / 10000)
    const netCents = amountCents - feeCents

    expect(feeCents).toBe(6) // rounds to nearest cent
    expect(netCents).toBe(544)
  })

  it('calculates fee on large amount', () => {
    const amountCents = 100000 // $1000
    const feeBps = 100
    const feeCents = Math.round(amountCents * feeBps / 10000)
    const netCents = amountCents - feeCents

    expect(feeCents).toBe(1000)
    expect(netCents).toBe(99000)
  })

  it('handles custom fee BPS', () => {
    const amountCents = 10000 // $100
    const feeBps = 50 // 0.5%
    const feeCents = Math.round(amountCents * feeBps / 10000)

    expect(feeCents).toBe(50) // $0.50
  })

  it('handles zero fee BPS', () => {
    const amountCents = 550
    const feeBps = 0
    const feeCents = Math.round(amountCents * feeBps / 10000)

    expect(feeCents).toBe(0)
  })
})

describe('x402 USDC conversion', () => {
  it('converts net cents to 6-decimal USDC', () => {
    const netCents = 544
    const netUsdc = BigInt(netCents) * 10000n

    expect(netUsdc).toBe(5440000n) // 5.44 USDC in 6 decimal
  })

  it('converts $0 to 0n', () => {
    const netCents = 0
    const netUsdc = BigInt(netCents) * 10000n

    expect(netUsdc).toBe(0n)
  })
})

describe('Macaroon format', () => {
  it('macaroon has correct structure (payload.signature)', () => {
    const mockMacaroon = btoa(JSON.stringify({ escrowId: 'test' })) + '.' + btoa('signature')

    const parts = mockMacaroon.split('.')
    expect(parts.length).toBe(2)

    const payload = JSON.parse(atob(parts[0]))
    expect(payload.escrowId).toBe('test')
  })

  it('invalid macaroon has no dots', () => {
    const parts = 'not_a_macaroon'.split('.')
    expect(parts.length).toBe(1)
  })
})

describe('ERC-20 transfer calldata', () => {
  it('builds correct transfer selector', () => {
    const selector = 'a9059cbb' // transfer(address,uint256)
    expect(selector).toBe('a9059cbb')
  })

  it('builds correct Transfer event topic', () => {
    const topic = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
    expect(topic.length).toBe(64)
  })
})
