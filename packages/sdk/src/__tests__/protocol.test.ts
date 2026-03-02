import { describe, it, expect, beforeEach, vi } from 'vitest'
import { TrustProtocol, quickStart, generateKeypair } from '../index'

const mockFetch = vi.fn()

beforeEach(() => {
  mockFetch.mockReset()
  vi.stubGlobal('fetch', mockFetch)
})

// Helper: create a protocol instance with a real keypair
function createProtocol(opts?: { sandbox?: boolean; sandboxKey?: string; apiUrl?: string }) {
  const kp = generateKeypair()
  return {
    tp: new TrustProtocol({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      sandbox: opts?.sandbox,
      sandboxKey: opts?.sandboxKey,
      apiUrl: opts?.apiUrl,
    }),
    kp,
  }
}

// Helper: mock a successful response
function mockOk(data: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status,
    json: async () => ({ data }),
  })
}

// Helper: mock an error response
function mockErr(message: string, status = 400) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => ({ error: { message } }),
  })
}

describe('TrustProtocol constructor', () => {
  it('sets production API URL by default', async () => {
    const { tp } = createProtocol()
    mockOk({})
    await tp.getStats()
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('api.trustthenverify.com'),
      expect.anything(),
    )
  })

  it('uses sandbox URL when sandbox=true', async () => {
    const { tp } = createProtocol({ sandbox: true })
    mockOk({})
    await tp.getStats()
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('sandbox.trustthenverify.com'),
      expect.anything(),
    )
  })

  it('uses custom apiUrl when provided', async () => {
    const { tp } = createProtocol({ apiUrl: 'http://localhost:8787/v2' })
    mockOk({})
    await tp.getStats()
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('localhost:8787'),
      expect.anything(),
    )
  })

  it('initializes empty ObservationStore', () => {
    const { tp, kp } = createProtocol()
    expect(tp.observations.getFor(kp.publicKey)).toEqual([])
  })
})

describe('TrustProtocol.proposeEscrow', () => {
  it('sends POST to /escrow/propose with correct body', async () => {
    const { tp } = createProtocol()
    mockOk({ id: 'escrow-1', sellerId: 'seller-pk', status: 'proposed' })

    await tp.proposeEscrow({
      seller: 'seller-pk',
      amountCents: 10000,
      taskSpec: { query: 'test' },
    })

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/escrow/propose'),
      expect.objectContaining({ method: 'POST' }),
    )
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(callBody.seller).toBe('seller-pk')
    expect(callBody.amountCents).toBe(10000)
  })

  it('calculates sellerCollateral from collateralRatio * amountCents', async () => {
    const { tp } = createProtocol()
    mockOk({ id: 'escrow-1' })

    await tp.proposeEscrow({
      seller: 'seller-pk',
      amountCents: 10000,
      collateralRatio: 0.3,
      taskSpec: { query: 'test' },
    })

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(callBody.sellerCollateral).toBe(3000)
  })

  it('defaults collateralRatio to 0.5', async () => {
    const { tp } = createProtocol()
    mockOk({ id: 'escrow-1' })

    await tp.proposeEscrow({
      seller: 'seller-pk',
      amountCents: 10000,
      taskSpec: { query: 'test' },
    })

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(callBody.sellerCollateral).toBe(5000)
  })

  it('defaults verificationMethod to buyer_confirm', async () => {
    const { tp } = createProtocol()
    mockOk({ id: 'escrow-1' })

    await tp.proposeEscrow({
      seller: 'seller-pk',
      amountCents: 1000,
      taskSpec: {},
    })

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(callBody.verificationMethod).toBe('buyer_confirm')
  })

  it('defaults timeoutSeconds to 3600', async () => {
    const { tp } = createProtocol()
    mockOk({ id: 'escrow-1' })

    await tp.proposeEscrow({
      seller: 'seller-pk',
      amountCents: 1000,
      taskSpec: {},
    })

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(callBody.timeoutSeconds).toBe(3600)
  })

  it('returns parsed escrow from response.data', async () => {
    const { tp } = createProtocol()
    const escrowData = { id: 'escrow-1', sellerId: 'seller-pk', status: 'proposed' }
    mockOk(escrowData)

    const result = await tp.proposeEscrow({
      seller: 'seller-pk',
      amountCents: 1000,
      taskSpec: {},
    })

    expect(result).toEqual(escrowData)
  })

  it('throws on non-ok response with API error message', async () => {
    const { tp } = createProtocol()
    mockErr('Seller not registered', 400)

    await expect(tp.proposeEscrow({
      seller: 'unknown',
      amountCents: 1000,
      taskSpec: {},
    })).rejects.toThrow('Seller not registered')
  })
})

describe('TrustProtocol.acceptEscrow', () => {
  it('sends POST to /escrow/:id/accept with empty body', async () => {
    const { tp } = createProtocol()
    mockOk({ id: 'escrow-1', status: 'accepted' })

    await tp.acceptEscrow('escrow-1')

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/escrow/escrow-1/accept'),
      expect.objectContaining({ method: 'POST' }),
    )
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(callBody).toEqual({})
  })

  it('returns parsed escrow', async () => {
    const { tp } = createProtocol()
    const escrowData = { id: 'escrow-1', status: 'accepted' }
    mockOk(escrowData)

    const result = await tp.acceptEscrow('escrow-1')
    expect(result).toEqual(escrowData)
  })
})

describe('TrustProtocol.deliver', () => {
  it('sends POST with { deliverable } in body', async () => {
    const { tp } = createProtocol()
    mockOk({ id: 'ver-1', result: 'pass' })

    await tp.deliver('escrow-1', { output: 'result data' })

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(callBody).toEqual({ deliverable: { output: 'result data' } })
  })

  it('returns VerificationResult', async () => {
    const { tp } = createProtocol()
    const verResult = { id: 'ver-1', escrowId: 'escrow-1', method: 'automated_reasoning', result: 'pass' }
    mockOk(verResult)

    const result = await tp.deliver('escrow-1', { output: 'data' })
    expect(result).toEqual(verResult)
  })
})

describe('TrustProtocol.confirmDelivery', () => {
  it('sends POST to /escrow/:id/confirm', async () => {
    const { tp } = createProtocol()
    mockOk({ id: 'escrow-1', sellerId: 'seller-pk', status: 'released', verificationMethod: 'buyer_confirm' })

    await tp.confirmDelivery('escrow-1')

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/escrow/escrow-1/confirm'),
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('records success observation for seller (auto side-effect)', async () => {
    const { tp } = createProtocol()
    mockOk({
      id: 'escrow-1',
      sellerId: 'seller-pk',
      status: 'released',
      verificationMethod: 'buyer_confirm',
    })

    await tp.confirmDelivery('escrow-1')

    const obs = tp.observations.getFor('seller-pk')
    expect(obs).toHaveLength(1)
    expect(obs[0].outcome).toBe('success')
  })
})

describe('TrustProtocol.disputeEscrow', () => {
  it('sends POST with { reason }', async () => {
    const { tp, kp } = createProtocol()
    mockOk({
      id: 'escrow-1',
      buyerId: kp.publicKey,
      sellerId: 'seller-pk',
      status: 'disputed',
    })

    await tp.disputeEscrow('escrow-1', 'Deliverable is wrong')

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(callBody).toEqual({ reason: 'Deliverable is wrong' })
  })

  it('records failure observation for counterparty', async () => {
    const { tp, kp } = createProtocol()
    mockOk({
      id: 'escrow-1',
      buyerId: kp.publicKey,
      sellerId: 'seller-pk',
      status: 'disputed',
    })

    await tp.disputeEscrow('escrow-1', 'Bad work')

    // We are the buyer, so observation is against the seller
    const obs = tp.observations.getFor('seller-pk')
    expect(obs).toHaveLength(1)
    expect(obs[0].outcome).toBe('failure')
  })
})

describe('TrustProtocol.listEscrows', () => {
  it('appends status and role query params', async () => {
    const { tp } = createProtocol()
    mockOk({ escrows: [], cursor: null })

    await tp.listEscrows({ status: 'active', role: 'buyer' })

    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('status=active')
    expect(url).toContain('role=buyer')
  })

  it('appends cursor when provided', async () => {
    const { tp } = createProtocol()
    mockOk({ escrows: [], cursor: null })

    await tp.listEscrows({ cursor: 'abc123' })

    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('cursor=abc123')
  })

  it('sends GET with no body', async () => {
    const { tp } = createProtocol()
    mockOk({ escrows: [], cursor: null })

    await tp.listEscrows()

    expect(mockFetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ method: 'POST' }),
    )
  })
})

describe('TrustProtocol.setupStripeCustomer', () => {
  it('sends POST to /agents/:pubkey/stripe/customer', async () => {
    const { tp, kp } = createProtocol()
    mockOk({ id: 'agent-1', stripeCustomerId: 'cus_test' })

    await tp.setupStripeCustomer()

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/agents/${kp.publicKey}/stripe/customer`),
      expect.objectContaining({ method: 'POST' }),
    )
  })
})

describe('TrustProtocol.setupStripeConnect', () => {
  it('sends POST with returnUrl and refreshUrl', async () => {
    const { tp } = createProtocol()
    mockOk({ agent: {}, onboardingUrl: 'https://connect.stripe.com/...' })

    await tp.setupStripeConnect({
      returnUrl: 'https://example.com/return',
      refreshUrl: 'https://example.com/refresh',
    })

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(callBody.returnUrl).toBe('https://example.com/return')
    expect(callBody.refreshUrl).toBe('https://example.com/refresh')
  })
})

describe('TrustProtocol auth headers', () => {
  it('uses sandbox key when sandbox=true and sandboxKey provided', async () => {
    const { tp } = createProtocol({ sandbox: true, sandboxKey: 'test_key_123' })
    mockOk({})

    await tp.getStats()

    const headers = mockFetch.mock.calls[0][1].headers
    expect(headers['X-Sandbox-Key']).toBe('test_key_123')
    expect(headers['X-Agent-Signature']).toBeUndefined()
  })

  it('falls back to ECDSA when sandbox=true but no sandboxKey', async () => {
    const { tp } = createProtocol({ sandbox: true })
    mockOk({})

    await tp.getStats()

    const headers = mockFetch.mock.calls[0][1].headers
    expect(headers['X-Agent-Signature']).toBeDefined()
    expect(headers['X-Agent-Timestamp']).toBeDefined()
  })

  it('uses ECDSA in production mode', async () => {
    const { tp } = createProtocol()
    mockOk({})

    await tp.getStats()

    const headers = mockFetch.mock.calls[0][1].headers
    expect(headers['X-Agent-Signature']).toBeDefined()
    expect(headers['X-Agent-Timestamp']).toBeDefined()
    expect(headers['X-Agent-Pubkey']).toBeDefined()
  })
})

describe('TrustProtocol error handling', () => {
  it('throws Error with message from API error envelope', async () => {
    const { tp } = createProtocol()
    mockErr('Escrow not found', 404)

    await expect(tp.getEscrow('bad-id')).rejects.toThrow('Escrow not found')
  })

  it('throws generic message when no error.message in response', async () => {
    const { tp } = createProtocol()
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: {} }),
    })

    await expect(tp.getEscrow('bad-id')).rejects.toThrow('Request failed: 500')
  })

  it('throws on network error (fetch rejects)', async () => {
    const { tp } = createProtocol()
    mockFetch.mockRejectedValueOnce(new Error('Network error'))

    await expect(tp.getEscrow('any')).rejects.toThrow('Network error')
  })
})

describe('quickStart', () => {
  it('generates keypair, registers agent, returns TrustProtocol', async () => {
    // First call: createAgent POST
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ data: { id: 'agent-new', publicKey: 'pk' } }),
    })

    const tp = await quickStart({ sandbox: true, sandboxKey: 'test_key' })

    expect(tp).toBeInstanceOf(TrustProtocol)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    // Verify registration was called
    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('/agents')
  })

  it('defaults to sandbox=true', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ data: { id: 'agent-new' } }),
    })

    const tp = await quickStart({ sandboxKey: 'key' })

    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('sandbox.trustthenverify.com')
    expect(tp).toBeInstanceOf(TrustProtocol)
  })

  it('passes name and capabilities to createAgent', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ data: { id: 'agent-new' } }),
    })

    await quickStart({
      sandbox: true,
      sandboxKey: 'key',
      name: 'Test Bot',
      capabilities: ['search', 'analysis'],
    })

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(callBody.name).toBe('Test Bot')
    expect(callBody.capabilities).toEqual(['search', 'analysis'])
  })
})
