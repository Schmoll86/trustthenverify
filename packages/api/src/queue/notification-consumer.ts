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
  if (!env.EMAIL_API_KEY) return // No email service configured

  const db = createDb(env)

  const { data: agent } = await db
    .from('agents')
    .select('email, notification_preferences')
    .eq('id', msg.agentId)
    .single()

  if (!agent) return

  const row = agent as unknown as { email: string | null; notification_preferences: Record<string, boolean> | null }
  if (!row.email) return

  // Check preference
  const prefs = row.notification_preferences ?? {}
  const prefKey = eventTypeToPrefKey(msg.eventType)
  if (prefKey && prefs[prefKey] === false) return // Explicitly opted out

  const email = new RealEmailService(env.EMAIL_API_KEY)
  const { subject, text } = buildEscrowEmail(msg.eventType, msg.escrowId, msg.payload)
  await email.sendEmail({ to: row.email, subject, text })
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
  }
  return map[eventType] ?? null
}
