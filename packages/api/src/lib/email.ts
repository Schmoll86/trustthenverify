/**
 * Email dispatch service — sends transactional emails via Resend REST API.
 * No npm dep required — uses raw fetch().
 */

export interface EmailService {
  sendEmail(params: {
    to: string
    subject: string
    text: string
  }): Promise<void>
}

export class RealEmailService implements EmailService {
  private apiKey: string
  private fromAddress: string

  constructor(apiKey: string, fromAddress = 'notifications@trustthenverify.com') {
    this.apiKey = apiKey
    this.fromAddress = fromAddress
  }

  async sendEmail(params: { to: string; subject: string; text: string }): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.fromAddress,
        to: [params.to],
        subject: params.subject,
        text: params.text,
      }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { message?: string }
      console.error('[email] Send failed:', res.status, err)
      // Non-fatal — don't throw, just log. Emails are best-effort.
    }
  }
}

/** Build a notification email body for an escrow event. */
export function buildEscrowEmail(eventType: string, escrowId: string, details: Record<string, unknown>): {
  subject: string
  text: string
} {
  const escrowShort = escrowId.slice(0, 8)
  const dashboardUrl = `https://trustthenverify.com/dashboard`

  const subjects: Record<string, string> = {
    'escrow.proposed': `New escrow proposed (${escrowShort})`,
    'escrow.accepted': `Escrow accepted (${escrowShort})`,
    'escrow.delivered': `Delivery submitted (${escrowShort})`,
    'escrow.released': `Escrow released (${escrowShort})`,
    'escrow.failed': `Escrow failed (${escrowShort})`,
    'escrow.disputed': `Dispute filed (${escrowShort})`,
    'escrow.expired': `Escrow expired (${escrowShort})`,
    'dispute.ruling': `Dispute ruling issued (${escrowShort})`,
  }

  const subject = subjects[eventType] || `Escrow update (${escrowShort})`

  const text = [
    `TrustThenVerify — ${subject}`,
    '',
    `Escrow ID: ${escrowId}`,
    `Event: ${eventType}`,
    details.amountCents ? `Amount: $${(details.amountCents as number / 100).toFixed(2)}` : '',
    details.status ? `Status: ${details.status}` : '',
    details.ruling ? `Ruling: ${details.ruling}` : '',
    '',
    `View in dashboard: ${dashboardUrl}`,
    '',
    '---',
    'You received this email because you registered for notifications on TrustThenVerify.',
    'To unsubscribe, update your notification preferences in the dashboard.',
  ].filter(Boolean).join('\n')

  return { subject, text }
}
