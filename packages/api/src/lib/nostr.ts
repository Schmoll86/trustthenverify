/**
 * Nostr service — NIP-01 event construction, Schnorr signing, relay publishing.
 * Uses kind 30078 (NIP-78 application-specific data) to avoid polluting social feeds.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { hashes } from '@noble/secp256k1'

// Configure sha256 for Schnorr operations (noble v3 requires explicit setup)
if (!hashes.sha256) {
  hashes.sha256 = (...msgs: Uint8Array[]) => {
    const h = sha256.create()
    for (const m of msgs) h.update(m)
    return h.digest()
  }
}

export interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export interface NostrService {
  publish(event: NostrEvent): Promise<string | null>
}

/**
 * Build a NIP-01 Nostr event for an attestation.
 * Signs with Schnorr (required by NIP-01) using the gateway private key.
 */
export async function buildAttestationEvent(
  content: {
    subjectPubkey: string
    outcome: string
    escrowId?: string | null
    verificationMethod?: string | null
    authorId: string
    timestamp: string
  },
  privateKeyHex: string,
): Promise<NostrEvent> {
  const { schnorr } = await import('@noble/secp256k1')

  const pubkey = bytesToHex(schnorr.getPublicKey(hexToBytes(privateKeyHex)))
  const created_at = Math.floor(new Date(content.timestamp).getTime() / 1000)
  const kind = 30078
  const tags: string[][] = [
    ['d', 'ttv_attestation'],
    ['subject', content.subjectPubkey],
    ['outcome', content.outcome],
  ]
  const contentStr = JSON.stringify({
    protocol: 'trustthenverify',
    version: 2,
    authorId: content.authorId,
    subjectPubkey: content.subjectPubkey,
    outcome: content.outcome,
    escrowId: content.escrowId ?? null,
    verificationMethod: content.verificationMethod ?? null,
    timestamp: content.timestamp,
  })

  // NIP-01: event id = SHA-256 of serialized event [0, pubkey, created_at, kind, tags, content]
  const serialized = JSON.stringify([0, pubkey, created_at, kind, tags, contentStr])
  const idBytes = sha256(utf8ToBytes(serialized))
  const id = bytesToHex(idBytes)

  // Schnorr signature over the event ID
  const sig = await schnorr.signAsync(idBytes, hexToBytes(privateKeyHex))
  const sigHex = bytesToHex(sig)

  return { id, pubkey, created_at, kind, tags, content: contentStr, sig: sigHex }
}

/**
 * Real Nostr relay publisher. Uses WebSocket via fetch() (Cloudflare Workers compatible).
 * Sends EVENT message, waits for OK response with 5s timeout. Non-fatal on failure.
 */
export class RealNostrService implements NostrService {
  private relayUrls: string[]

  constructor(relayUrls: string[]) {
    this.relayUrls = relayUrls
  }

  async publish(event: NostrEvent): Promise<string | null> {
    if (this.relayUrls.length === 0) return null

    // Try each relay, return on first success
    for (const url of this.relayUrls) {
      try {
        const result = await this.publishToRelay(url, event)
        if (result) return event.id
      } catch {
        // Non-fatal — try next relay
      }
    }
    return null
  }

  private async publishToRelay(url: string, event: NostrEvent): Promise<boolean> {
    const wsUrl = url.replace(/^http/, 'ws')

    const resp = await fetch(wsUrl, {
      headers: { Upgrade: 'websocket' },
    })

    const ws = (resp as unknown as { webSocket: WebSocket }).webSocket
    if (!ws) return false

    ws.accept()

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        try { ws.close() } catch { /* ignore */ }
        resolve(false)
      }, 5000)

      ws.addEventListener('message', (msg) => {
        try {
          const data = JSON.parse(typeof msg.data === 'string' ? msg.data : '')
          if (Array.isArray(data) && data[0] === 'OK' && data[1] === event.id) {
            clearTimeout(timeout)
            try { ws.close() } catch { /* ignore */ }
            resolve(data[2] === true)
          }
        } catch {
          // Ignore parse errors
        }
      })

      ws.send(JSON.stringify(['EVENT', event]))
    })
  }
}
