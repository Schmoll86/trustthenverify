/**
 * TrustThenVerify — Shared Browser Library
 * Crypto, API, session management, and UI helpers.
 */

import { getPublicKey, signAsync } from 'https://esm.sh/@noble/secp256k1@3'
import { sha256 } from 'https://esm.sh/@noble/hashes@2/sha2'
import { bytesToHex, hexToBytes } from 'https://esm.sh/@noble/hashes@2/utils'

// ── Config ──────────────────────────────────────────────────────────────────

const PK_LIVE = 'pk_live_51ST8scJc7Iv6B67gXRZRTnkbmzEgMDdixvmUd8RkKhW8HIkccWIv9wrTdhnOGqqQnqLJl338Y4KlbiMmgtKLcnqY00WjcuChBX'

const URLS = {
  sandbox: 'https://sandbox.trustthenverify.com/v2',
  production: 'https://api.trustthenverify.com/v2',
}

let _env = 'sandbox'
let _apiUrl = URLS.sandbox

// ── Session ─────────────────────────────────────────────────────────────────

export function getSession() {
  const pub = sessionStorage.getItem('ttv_pubkey')
  const priv = sessionStorage.getItem('ttv_privkey')
  const env = sessionStorage.getItem('ttv_env') || 'sandbox'
  if (pub && priv) {
    _env = env
    _apiUrl = URLS[env] || URLS.sandbox
    return { publicKey: pub, privateKey: priv, env }
  }
  return null
}

export function saveSession(publicKey, privateKey, env) {
  sessionStorage.setItem('ttv_pubkey', publicKey)
  sessionStorage.setItem('ttv_privkey', privateKey)
  if (env) {
    sessionStorage.setItem('ttv_env', env)
    _env = env
    _apiUrl = URLS[env] || URLS.sandbox
  }
}

export function clearSession() {
  sessionStorage.removeItem('ttv_pubkey')
  sessionStorage.removeItem('ttv_privkey')
  sessionStorage.removeItem('ttv_env')
}

export function requireSession() {
  const s = getSession()
  if (!s) {
    window.location.href = '/onboard'
    return null
  }
  return s
}

// ── Environment ─────────────────────────────────────────────────────────────

export function getEnv() { return _env }

export function setEnv(env) {
  _env = env
  _apiUrl = URLS[env] || URLS.sandbox
  sessionStorage.setItem('ttv_env', env)
}

export function getApiUrl() { return _apiUrl }

// ── Crypto ──────────────────────────────────────────────────────────────────

export function generateKeypair() {
  const priv = new Uint8Array(32)
  crypto.getRandomValues(priv)
  const pub = getPublicKey(priv, true)
  return { privateKey: bytesToHex(priv), publicKey: bytesToHex(pub) }
}

async function ecdsaHeaders(method, path, bodyStr, session) {
  const ts = Math.floor(Date.now() / 1000)
  const encoder = new TextEncoder()
  const bodyHash = bytesToHex(sha256(encoder.encode(bodyStr || '')))
  const canonical = `${ts}\n${method}\n${path}\n${bodyHash}`
  const msgHash = sha256(encoder.encode(canonical))
  const sig = await signAsync(msgHash, hexToBytes(session.privateKey), { prehash: false })
  return {
    'Content-Type': 'application/json',
    'X-Agent-Pubkey': session.publicKey,
    'X-Agent-Timestamp': String(ts),
    'X-Agent-Signature': bytesToHex(sig),
  }
}

// ── API ─────────────────────────────────────────────────────────────────────

export async function apiPost(path, body) {
  const session = getSession()
  if (!session) throw new Error('No session')
  const bodyStr = JSON.stringify(body)
  const headers = await ecdsaHeaders('POST', path, bodyStr, session)
  const res = await fetch(_apiUrl + path, { method: 'POST', headers, body: bodyStr })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`)
  return json.data
}

export async function apiGet(path) {
  const session = getSession()
  if (!session) throw new Error('No session')
  const headers = await ecdsaHeaders('GET', path, '', session)
  const res = await fetch(_apiUrl + path, { headers })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`)
  return json.data
}

export async function apiGetPublic(path) {
  const res = await fetch(_apiUrl + path)
  const json = await res.json()
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`)
  return json.data
}

// ── UI Helpers ──────────────────────────────────────────────────────────────

export function statusBadge(status) {
  const labels = {
    proposed: 'Proposed',
    active: 'Active',
    delivered: 'Delivered',
    released: 'Released',
    failed: 'Failed',
    disputed: 'Disputed',
    resolved: 'Resolved',
  }
  const label = labels[status] || status
  return `<span class="badge badge-${status}">${label}</span>`
}

export function formatCents(cents) {
  if (cents == null) return '$0.00'
  return '$' + (cents / 100).toFixed(2)
}

export function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function truncateKey(hex) {
  if (!hex || hex.length < 12) return hex || ''
  return hex.slice(0, 8) + '...' + hex.slice(-6)
}

export function renderNav(activePage) {
  const session = getSession()
  const ctaHref = session ? '/dashboard' : '/onboard'
  const ctaText = session ? 'Dashboard' : 'Get Started'

  return `<nav>
  <div class="nav-inner">
    <a href="/" class="logo" aria-label="TrustThenVerify home">
      <img src="logo.jpg" alt="TrustThenVerify shield logo" class="logo-img">
      TrustThenVerify
    </a>
    <div class="nav-links">
      <a href="/docs"${activePage === 'docs' ? ' style="color:var(--text)"' : ''}>Docs</a>
      <a href="/quickstart"${activePage === 'quickstart' ? ' style="color:var(--text)"' : ''}>Quickstart</a>
      <a href="/marketplace"${activePage === 'marketplace' ? ' style="color:var(--text)"' : ''}>Marketplace</a>
      <a href="https://github.com/Schmoll86/trustthenverify">GitHub</a>
      <a href="https://x.com/billythemanbot">X</a>
      <a href="https://www.npmjs.com/package/@trustthenverify/sdk">SDK</a>
      <a href="https://www.npmjs.com/package/@trustthenverify/mcp">MCP</a>
      <a href="https://api.trustthenverify.com/v2/health" class="nav-status">API&thinsp;<span class="dot" aria-label="status"></span></a>
      <a href="${ctaHref}" class="nav-cta">${ctaText}</a>
    </div>
  </div>
</nav>`
}

// ── Stripe ──────────────────────────────────────────────────────────────────

export { PK_LIVE }

// ── Re-exports for pages that need raw crypto ───────────────────────────────

export { getPublicKey, signAsync, sha256, bytesToHex, hexToBytes }
