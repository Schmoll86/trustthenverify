import { describe, it, expect } from 'vitest'
import {
  signChannelPayment,
  verifyChannelPayment,
  generateKeypair,
} from '@trustthenverify/sdk'

describe('Payment channel signing (SDK)', () => {
  const channelAddress = '0x' + 'ab'.repeat(20)

  it('signs and verifies a channel payment', async () => {
    const keypair = generateKeypair()

    const payment = await signChannelPayment(
      keypair.privateKey,
      channelAddress,
      100000000n, // 100 USDC
    )

    expect(payment.channelAddress).toBe(channelAddress)
    expect(payment.amount).toBe(100000000n)
    expect(payment.signature).toHaveLength(130) // 65 bytes = 130 hex chars

    const valid = verifyChannelPayment(payment, keypair.publicKey)
    expect(valid).toBe(true)
  })

  it('rejects tampered amount', async () => {
    const keypair = generateKeypair()

    const payment = await signChannelPayment(
      keypair.privateKey,
      channelAddress,
      100000000n,
    )

    // Tamper with amount
    const tampered = { ...payment, amount: 200000000n }
    const valid = verifyChannelPayment(tampered, keypair.publicKey)
    expect(valid).toBe(false)
  })

  it('rejects wrong signer', async () => {
    const signer = generateKeypair()
    const other = generateKeypair()

    const payment = await signChannelPayment(
      signer.privateKey,
      channelAddress,
      50000000n,
    )

    const valid = verifyChannelPayment(payment, other.publicKey)
    expect(valid).toBe(false)
  })

  it('handles zero amount', async () => {
    const keypair = generateKeypair()

    const payment = await signChannelPayment(
      keypair.privateKey,
      channelAddress,
      0n,
    )

    const valid = verifyChannelPayment(payment, keypair.publicKey)
    expect(valid).toBe(true)
  })

  it('handles incrementing payments (newest is valid)', async () => {
    const keypair = generateKeypair()

    const payment1 = await signChannelPayment(keypair.privateKey, channelAddress, 10n)
    const payment2 = await signChannelPayment(keypair.privateKey, channelAddress, 20n)
    const payment3 = await signChannelPayment(keypair.privateKey, channelAddress, 30n)

    // All are independently valid
    expect(verifyChannelPayment(payment1, keypair.publicKey)).toBe(true)
    expect(verifyChannelPayment(payment2, keypair.publicKey)).toBe(true)
    expect(verifyChannelPayment(payment3, keypair.publicKey)).toBe(true)

    // Each has different signature
    expect(payment1.signature).not.toBe(payment2.signature)
    expect(payment2.signature).not.toBe(payment3.signature)
  })
})
