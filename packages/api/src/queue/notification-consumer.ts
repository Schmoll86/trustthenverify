/**
 * Notification queue consumer — processes email notifications for escrow events.
 * Looks up agent email + preferences, sends if opted in.
 */

import { createDb, type Env } from '../lib/db'
import { RealEmailService, buildEscrowEmail } from '../lib/email'

export interface NotificationQueueMessage {
  type: 'notification'
  agentId: string
  eventType: string
  escrowId: string
  payload: Record<string, unknown>
}

export async function handleNotification(msg: NotificationQueueMessage, env: Env): Promise<void> {
  const db = createDb(env)

  const { data: agent } = await db
    .from('agents')
    .select('email, notification_preferences, webhook_url, webhook_secret')
    .eq('id', msg.agentId)
    .single()

  if (!agent) return

  const row = agent as unknown as {
    email: string | null
    notification_preferences: Record<string, boolean> | null
    webhook_url: string | null
    webhook_secret: string | null
  }

  // Check preference
  const prefs = row.notification_preferences ?? {}
  const prefKey = eventTypeToPrefKey(msg.eventType)
  const optedOut = prefKey && prefs[prefKey] === false

  // Email delivery
  if (env.EMAIL_API_KEY && row.email && !optedOut) {
    const emailSvc = new RealEmailService(env.EMAIL_API_KEY)
    const { subject, text } = buildEscrowEmail(msg.eventType, msg.escrowId, msg.payload)
    try {
      await emailSvc.sendEmail({ to: row.email, subject, text })
    } catch {
      // Non-fatal — email delivery is best-effort
    }
  }

  // Webhook delivery
  if (row.webhook_url && row.webhook_secret) {
    const payload = JSON.stringify({
      event: msg.eventType,
      escrowId: msg.escrowId,
      timestamp: Date.now(),
      data: msg.payload,
    })

    // HMAC-SHA256 signature
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(row.webhook_secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
    const sig = Array.from(new Uint8Array(mac))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')

    try {
      await fetch(row.webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-TTV-Signature': sig,
          'X-TTV-Event': msg.eventType,
        },
        body: payload,
      })
    } catch {
      // Non-fatal — webhook delivery is best-effort
    }
  }
}

function eventTypeToPrefKey(eventType: string): string | null {
  const map: Record<string, string> = {
    'escrow.proposed': 'escrowProposed',
    'escrow.accepted': 'escrowAccepted',
    'escrow.delivered': 'deliverySubmitted',
    'escrow.released': 'verificationResult',
    'escrow.failed': 'verificationResult',
    'escrow.disputed': 'disputeFiled',
    'escrow.expired': 'escrowProposed',
    'dispute.ruling': 'disputeFiled',
    'kyc.complete': 'escrowAccepted',
  }
  return map[eventType] ?? null
}
