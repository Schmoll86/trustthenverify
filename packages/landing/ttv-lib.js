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
  // Check localStorage first (persisted sessions), then sessionStorage
  const pub = localStorage.getItem('ttv_pubkey') || sessionStorage.getItem('ttv_pubkey')
  const priv = localStorage.getItem('ttv_privkey') || sessionStorage.getItem('ttv_privkey')
  const env = localStorage.getItem('ttv_env') || sessionStorage.getItem('ttv_env') || 'sandbox'
  if (pub && priv) {
    _env = env
    _apiUrl = URLS[env] || URLS.sandbox
    return { publicKey: pub, privateKey: priv, env }
  }
  return null
}

export function saveSession(publicKey, privateKey, env, persist = false) {
  const store = persist ? localStorage : sessionStorage
  store.setItem('ttv_pubkey', publicKey)
  store.setItem('ttv_privkey', privateKey)
  if (env) {
    store.setItem('ttv_env', env)
    _env = env
    _apiUrl = URLS[env] || URLS.sandbox
  }
}

export function clearSession() {
  sessionStorage.removeItem('ttv_pubkey')
  sessionStorage.removeItem('ttv_privkey')
  sessionStorage.removeItem('ttv_env')
  localStorage.removeItem('ttv_pubkey')
  localStorage.removeItem('ttv_privkey')
  localStorage.removeItem('ttv_env')
}

export function isSessionPersisted() {
  return !!localStorage.getItem('ttv_pubkey')
}

// ── Key Export / Import (AES-256-GCM via Web Crypto) ────────────────────────

export async function exportKeyBundle(password) {
  const session = getSession()
  if (!session) throw new Error('No session to export')

  const enc = new TextEncoder()
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))

  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
  )
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt']
  )

  const plaintext = enc.encode(JSON.stringify({
    publicKey: session.publicKey,
    privateKey: session.privateKey,
  }))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plaintext)

  const bundle = {
    version: 1,
    encrypted: _bufToBase64(new Uint8Array(ciphertext)),
    iv: _bufToBase64(iv),
    salt: _bufToBase64(salt),
  }

  // Trigger download
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'ttv-keys.json'
  a.click()
  URL.revokeObjectURL(url)
  return bundle
}

export async function importKeyBundle(file, password) {
  const text = await file.text()
  const bundle = JSON.parse(text)
  if (bundle.version !== 1) throw new Error('Unsupported key file version')

  const enc = new TextEncoder()
  const salt = _base64ToBuf(bundle.salt)
  const iv = _base64ToBuf(bundle.iv)
  const ciphertext = _base64ToBuf(bundle.encrypted)

  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
  )
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
  )

  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext)
  const { publicKey, privateKey } = JSON.parse(new TextDecoder().decode(plaintext))
  return { publicKey, privateKey }
}

function _bufToBase64(buf) {
  return btoa(String.fromCharCode(...buf))
}

function _base64ToBuf(b64) {
  const bin = atob(b64)
  const buf = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
  return buf
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
  // Persist env in whichever store has the session
  if (localStorage.getItem('ttv_pubkey')) {
    localStorage.setItem('ttv_env', env)
  } else {
    sessionStorage.setItem('ttv_env', env)
  }
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
  const sessionLinks = session
    ? `<a href="#" class="nav-signout" onclick="event.preventDefault();import('./ttv-lib.js').then(m=>{m.clearSession();location.href='/'})">Sign out</a>`
    : `<a href="/recover"${activePage === 'recover' ? ' style="color:var(--text)"' : ''}>Recover</a>`

  return `<nav>
  <div class="nav-inner">
    <a href="/" class="logo" aria-label="TrustThenVerify home">
      <img src="logo.jpg" alt="TrustThenVerify shield logo" class="logo-img">
      TrustThenVerify
    </a>
    <button class="hamburger" aria-label="Toggle navigation" onclick="this.classList.toggle('open');this.nextElementSibling.classList.toggle('nav-open')">
      <span></span><span></span><span></span>
    </button>
    <div class="nav-links">
      <a href="/docs"${activePage === 'docs' ? ' style="color:var(--text)"' : ''}>Docs</a>
      <a href="/quickstart"${activePage === 'quickstart' ? ' style="color:var(--text)"' : ''}>Quickstart</a>
      <a href="/marketplace"${activePage === 'marketplace' ? ' style="color:var(--text)"' : ''}>Marketplace</a>
      <a href="https://github.com/Schmoll86/trustthenverify">GitHub</a>
      <a href="https://x.com/billythemanbot">X</a>
      <a href="https://www.npmjs.com/package/@trustthenverify/sdk">SDK</a>
      <a href="https://www.npmjs.com/package/@trustthenverify/mcp">MCP</a>
      <a href="https://api.trustthenverify.com/v2/health" class="nav-status">API&thinsp;<span class="dot" aria-label="status"></span></a>
      ${sessionLinks}
      <a href="${ctaHref}" class="nav-cta">${ctaText}</a>
    </div>
  </div>
</nav>`
}

/** Close mobile nav when a link is clicked. Call after inserting nav HTML. */
export function initMobileNav() {
  const links = document.querySelector('.nav-links')
  const hamburger = document.querySelector('.hamburger')
  if (!links || !hamburger) return
  links.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') {
      hamburger.classList.remove('open')
      links.classList.remove('nav-open')
    }
  })
}

export function renderFooter() {
  return `<footer>
  <div class="footer-inner">
    <div class="footer-left">
      <img src="logo.jpg" alt="" width="20" height="20" style="border-radius: 3px;">
      <span>FindSquad, Inc.</span>
    </div>
    <div class="footer-links">
      <a href="/terms">Terms</a>
      <a href="/privacy">Privacy</a>
      <a href="https://github.com/Schmoll86/trustthenverify">GitHub</a>
      <a href="https://x.com/billythemanbot">X / Twitter</a>
      <a href="https://www.npmjs.com/package/@trustthenverify/sdk">SDK</a>
      <a href="https://www.npmjs.com/package/@trustthenverify/mcp">MCP</a>
      <a href="https://api.trustthenverify.com/v2/health">API</a>
    </div>
  </div>
</footer>`
}

// ── Stripe ──────────────────────────────────────────────────────────────────

export { PK_LIVE }

// ── Re-exports for pages that need raw crypto ───────────────────────────────

export { getPublicKey, signAsync, sha256, bytesToHex, hexToBytes }
