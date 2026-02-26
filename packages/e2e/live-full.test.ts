/**
 * Live production tests — api.trustthenverify.com with real ECDSA auth.
 *
 * What works without Stripe Connect:
 *   - Health, auth, agents, search, Stripe customer (buyer side),
 *     policies, payment channels, response envelope, rate limiting
 *
 * What requires Stripe Connect seller onboarding (SKIPPED):
 *   - Full escrow lifecycle (accept requires Stripe on both sides)
 *   - Attestations (need released escrow)
 */

import { describe, it, expect } from 'vitest'
import {
  generateKeypair,
  signRequest,
} from '@trustthenverify/sdk'

const API_URL = 'https://api.trustthenverify.com'

// ── Helpers ──────────────────────────────────────────────────────────────────

async function authedFetch(
  method: string,
  path: string,
  body: unknown,
  keypair: ReturnType<typeof generateKeypair>,
) {
  const bodyStr = body ? JSON.stringify(body) : ''
  const timestamp = Math.floor(Date.now() / 1000)
  const sigPath = path.replace('/v2', '')
  const signature = await signRequest(keypair.privateKey, method, sigPath, bodyStr, timestamp)

  const headers: Record<string, string> = {
    'X-Agent-Pubkey': keypair.publicKey,
    'X-Agent-Timestamp': String(timestamp),
    'X-Agent-Signature': signature,
    'Content-Type': 'application/json',
  }

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : bodyStr || undefined,
  })

  const text = await res.text()
  let json: { data?: unknown; error?: { code: string; message: string }; meta?: unknown }
  try {
    json = JSON.parse(text)
  } catch {
    return { status: res.status, data: undefined, error: { code: 'PARSE_ERROR', message: text.slice(0, 200) }, meta: undefined, headers: res.headers }
  }
  return { status: res.status, data: json.data, error: json.error, meta: json.meta, headers: res.headers }
}

// ── Health ────────────────────────────────────────────────────────────────────

describe('Production — Health', { timeout: 15_000 }, () => {
  it('GET / returns API info', async () => {
    const res = await fetch(`${API_URL}/`)
    expect(res.status).toBe(200)
    const json = await res.json() as { name: string; version: string }
    expect(json.name).toBe('TrustThenVerify API')
    expect(json.version).toBe('2.0.0')
  })

  it('GET /v2/health returns ok', async () => {
    const res = await fetch(`${API_URL}/v2/health`)
    expect(res.status).toBe(200)
    const json = await res.json() as { status: string }
    expect(json.status).toBe('ok')
  })
})

// ── ECDSA Auth ───────────────────────────────────────────────────────────────

describe('Production — ECDSA Auth', { timeout: 30_000 }, () => {
  const agent = generateKeypair()

  it('rejects unsigned request', async () => {
    const res = await fetch(`${API_URL}/v2/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: agent.publicKey, name: 'test' }),
    })
    expect(res.status).toBe(401)
  })

  it('rejects expired timestamp (10 min old)', async () => {
    const bodyStr = JSON.stringify({ publicKey: agent.publicKey, name: 'test' })
    const oldTimestamp = Math.floor(Date.now() / 1000) - 600
    const signature = await signRequest(agent.privateKey, 'POST', '/agents', bodyStr, oldTimestamp)

    const res = await fetch(`${API_URL}/v2/agents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Pubkey': agent.publicKey,
        'X-Agent-Timestamp': String(oldTimestamp),
        'X-Agent-Signature': signature,
      },
      body: bodyStr,
    })
    expect(res.status).toBe(401)
  })

  it('rejects invalid signature', async () => {
    const bodyStr = JSON.stringify({ publicKey: agent.publicKey, name: 'test' })
    const timestamp = Math.floor(Date.now() / 1000)

    const res = await fetch(`${API_URL}/v2/agents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Pubkey': agent.publicKey,
        'X-Agent-Timestamp': String(timestamp),
        'X-Agent-Signature': 'deadbeef'.repeat(16),
      },
      body: bodyStr,
    })
    expect(res.status).toBe(401)
  })

  it('accepts valid ECDSA signature', async () => {
    const { status, data } = await authedFetch('POST', '/v2/agents', {
      publicKey: agent.publicKey,
      name: 'live-auth-test',
      capabilities: ['test'],
    }, agent)
    expect(status).toBe(201)
    expect((data as Record<string, unknown>).publicKey).toBe(agent.publicKey)
  })
})

// ── Agent Lifecycle ──────────────────────────────────────────────────────────

describe('Production — Agent Lifecycle', { timeout: 30_000 }, () => {
  const agent = generateKeypair()

  it('registers agent with metadata', async () => {
    const { status, data } = await authedFetch('POST', '/v2/agents', {
      publicKey: agent.publicKey,
      name: 'live-lifecycle-agent',
      capabilities: ['data-retrieval', 'purchase'],
      metadata: { env: 'live-test' },
    }, agent)
    expect(status).toBe(201)
    const d = data as Record<string, unknown>
    expect(d.publicKey).toBe(agent.publicKey)
    expect(d.name).toBe('live-lifecycle-agent')
  })

  it('GET agent by pubkey', async () => {
    const { status, data } = await authedFetch('GET', `/v2/agents/${agent.publicKey}`, null, agent)
    expect(status).toBe(200)
    expect((data as Record<string, unknown>).name).toBe('live-lifecycle-agent')
  })

  it('search agents by capabilities', async () => {
    const { status, data } = await authedFetch('GET', '/v2/agents/search?capabilities=data-retrieval', null, agent)
    expect(status).toBe(200)
    expect(Array.isArray(data)).toBe(true)
  })

  it('duplicate registration returns 409', async () => {
    const { status } = await authedFetch('POST', '/v2/agents', {
      publicKey: agent.publicKey,
      name: 'duplicate',
    }, agent)
    expect(status).toBe(409)
  })
})

// ── Stripe Customer (Buyer Side) ─────────────────────────────────────────────

describe('Production — Stripe Customer (Buyer)', { timeout: 30_000 }, () => {
  const buyer = generateKeypair()

  it('creates live Stripe Customer', async () => {
    await authedFetch('POST', '/v2/agents', {
      publicKey: buyer.publicKey,
      name: 'live-stripe-buyer',
      capabilities: ['purchase'],
    }, buyer)

    const { status, data } = await authedFetch(
      'POST', `/v2/agents/${buyer.publicKey}/stripe/customer`, {}, buyer
    )
    expect(status).toBe(200)
    const d = data as Record<string, unknown>
    expect(d.stripeCustomerId).toBeTruthy()
    expect((d.stripeCustomerId as string).startsWith('cus_')).toBe(true)
  })

  it('duplicate customer returns 409', async () => {
    const { status } = await authedFetch(
      'POST', `/v2/agents/${buyer.publicKey}/stripe/customer`, {}, buyer
    )
    expect(status).toBe(409)
  })

  it('cannot create customer for other agent', async () => {
    const other = generateKeypair()
    await authedFetch('POST', '/v2/agents', { publicKey: other.publicKey, name: 'other' }, other)
    const { status } = await authedFetch(
      'POST', `/v2/agents/${other.publicKey}/stripe/customer`, {}, buyer
    )
    expect(status).toBe(403)
  })
})

// ── Escrow Propose (works without full Stripe) ──────────────────────────────

describe('Production — Escrow Propose', { timeout: 30_000 }, () => {
  const buyer = generateKeypair()
  const seller = generateKeypair()

  it('proposes escrow (Stripe mode)', async () => {
    await authedFetch('POST', '/v2/agents', { publicKey: buyer.publicKey, name: 'live-esc-buyer' }, buyer)
    await authedFetch('POST', '/v2/agents', { publicKey: seller.publicKey, name: 'live-esc-seller' }, seller)

    const { status, data } = await authedFetch('POST', '/v2/escrow/propose', {
      seller: seller.publicKey,
      amountCents: 100,
      taskSpec: { type: 'data-retrieval', query: 'live test' },
      verificationMethod: 'buyer_confirm',
    }, buyer)
    expect(status).toBe(201)
    const d = data as Record<string, unknown>
    expect(d.status).toBe('proposed')
    expect(d.amountCents).toBe(100)
  })

  it('proposes on-chain escrow', async () => {
    const { publicKeyToAddress } = await import('@trustthenverify/sdk')
    const { status, data } = await authedFetch('POST', '/v2/escrow/propose', {
      seller: seller.publicKey,
      amountCents: 5000,
      taskSpec: { type: 'data-retrieval', query: 'on-chain test' },
      verificationMethod: 'buyer_confirm',
      fundingMode: 'onchain',
      buyerAddress: publicKeyToAddress(buyer.publicKey),
      sellerAddress: publicKeyToAddress(seller.publicKey),
    }, buyer)
    expect(status).toBe(201)
    expect((data as Record<string, unknown>).fundingMode).toBe('onchain')
  })

  it('accept requires Stripe setup (expected)', async () => {
    const { data: escrow } = await authedFetch('POST', '/v2/escrow/propose', {
      seller: seller.publicKey,
      amountCents: 100,
      taskSpec: { type: 'data-retrieval', query: 'stripe check' },
      verificationMethod: 'buyer_confirm',
    }, buyer)
    const escrowId = (escrow as Record<string, unknown>).id as string

    const { status, error } = await authedFetch('POST', `/v2/escrow/${escrowId}/accept`, {}, seller)
    expect(status).toBe(400)
    expect(error?.code).toBe('STRIPE_NOT_CONFIGURED')
  })
})

// ── Policy CRUD ──────────────────────────────────────────────────────────────

describe('Production — Policy CRUD', { timeout: 30_000 }, () => {
  const agent = generateKeypair()
  let policyId: string

  it('creates policy with formalSpec', async () => {
    await authedFetch('POST', '/v2/agents', { publicKey: agent.publicKey, name: 'live-policy-agent' }, agent)

    const { status, data, error } = await authedFetch('POST', '/v2/policies', {
      name: 'live-test-policy',
      intent: 'Retrieve data results with freshness constraints',
      description: 'A test policy for live testing',
      formalSpec: {
        version: 1,
        constraints: [
          { id: 'rc1', type: 'count', target: '$.results', params: { min: 1, max: 10 } },
          { id: 'rf1', type: 'exists', target: '$.results[0].title', params: {} },
        ],
      },
    }, agent)
    if (status !== 201) console.log('policy create error:', error)
    expect(status).toBe(201)
    const d = data as Record<string, unknown>
    expect(d.name).toBe('live-test-policy')
    policyId = d.id as string
  })

  it('reads policy', async () => {
    const { status, data } = await authedFetch('GET', `/v2/policies/${policyId}`, null, agent)
    expect(status).toBe(200)
    expect((data as Record<string, unknown>).name).toBe('live-test-policy')
  })

  it('lists policy templates', async () => {
    const { status, data } = await authedFetch('GET', '/v2/policies/templates', null, agent)
    expect(status).toBe(200)
    expect(Array.isArray(data)).toBe(true)
  })
})

// ── Payment Channels ─────────────────────────────────────────────────────────

describe('Production — Payment Channels', { timeout: 30_000 }, () => {
  const buyer = generateKeypair()
  const seller = generateKeypair()
  const channelAddr = '0x' + crypto.randomUUID().replace(/-/g, '').slice(0, 40)

  it('registers channel', async () => {
    await authedFetch('POST', '/v2/agents', { publicKey: buyer.publicKey, name: 'live-ch-buyer' }, buyer)
    await authedFetch('POST', '/v2/agents', { publicKey: seller.publicKey, name: 'live-ch-seller' }, seller)

    const { status, data } = await authedFetch('POST', '/v2/channels', {
      channelAddress: channelAddr,
      counterparty: seller.publicKey,
      depositAmount: 1000,
      chainId: 84532,
      expiryAt: '2027-12-31T23:59:59Z',
    }, buyer)
    expect(status).toBe(201)
    expect((data as Record<string, unknown>).status).toBe('open')
  })

  it('buyer reads channel', async () => {
    const { status, data } = await authedFetch('GET', `/v2/channels/${channelAddr}`, null, buyer)
    expect(status).toBe(200)
    expect((data as Record<string, unknown>).depositAmount).toBe(1000)
  })

  it('seller reads channel', async () => {
    const { status, data } = await authedFetch('GET', `/v2/channels/${channelAddr}`, null, seller)
    expect(status).toBe(200)
    expect((data as Record<string, unknown>).status).toBe('open')
  })

  it('third party cannot read channel', async () => {
    const intruder = generateKeypair()
    await authedFetch('POST', '/v2/agents', { publicKey: intruder.publicKey, name: 'live-ch-intruder' }, intruder)
    const { status } = await authedFetch('GET', `/v2/channels/${channelAddr}`, null, intruder)
    expect(status).toBe(403)
  })

  it('closes channel', async () => {
    const { status, data } = await authedFetch('POST', `/v2/channels/${channelAddr}/close`, {}, buyer)
    expect(status).toBe(200)
    expect((data as Record<string, unknown>).status).toBe('closed')
  })

  it('double close returns 409', async () => {
    const { status } = await authedFetch('POST', `/v2/channels/${channelAddr}/close`, {}, buyer)
    expect(status).toBe(409)
  })
})

// ── Response Envelope ────────────────────────────────────────────────────────

describe('Production — Response Envelope', { timeout: 15_000 }, () => {
  it('success: data + meta.requestId', async () => {
    const agent = generateKeypair()
    const res = await authedFetch('POST', '/v2/agents', { publicKey: agent.publicKey, name: 'live-envelope' }, agent)
    expect(res.data).toBeTruthy()
    expect(res.meta).toBeTruthy()
    expect((res.meta as Record<string, unknown>).requestId).toBeTruthy()
  })

  it('error: error.code + meta.requestId', async () => {
    const res = await fetch(`${API_URL}/v2/escrow/nonexistent`)
    const json = await res.json() as { error?: { code: string }; meta?: { requestId: string } }
    expect(json.error).toBeTruthy()
    expect(json.error?.code).toBeTruthy()
    expect(json.meta).toBeTruthy()
    expect(json.meta?.requestId).toBeTruthy()
  })
})

// ── Rate Limiting ────────────────────────────────────────────────────────────

describe('Production — Rate Limiting', { timeout: 30_000 }, () => {
  it('returns rate limit headers on authenticated writes', async () => {
    const agent = generateKeypair()
    // Register agent first (registration skips rate limit — no agentId yet)
    await authedFetch('POST', '/v2/agents', { publicKey: agent.publicKey, name: 'live-ratelimit' }, agent)

    // Now make an authenticated write — Stripe customer creation
    const r = await authedFetch('POST', `/v2/agents/${agent.publicKey}/stripe/customer`, {}, agent)
    expect(r.status).toBe(200)

    const limit = r.headers.get('x-ratelimit-limit')
    expect(limit).toBeTruthy()
    expect(Number(limit)).toBe(60) // write limit

    const remaining = r.headers.get('x-ratelimit-remaining')
    expect(remaining).toBeTruthy()
    expect(Number(remaining)).toBeLessThanOrEqual(59)
    console.log(`Rate limit: ${remaining}/${limit} remaining`)
  })
})
