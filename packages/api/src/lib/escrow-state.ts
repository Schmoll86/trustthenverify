/**
 * Escrow state machine — pure functions per SPEC-v2 §2.2.
 *
 * States: proposed → active → delivered → released
 *                                       → failed (verification fail)
 *                                       → burned
 *         proposed → expired
 *         proposed → accepted (on-chain: seller accepts, awaiting funding)
 *         accepted → funded (on-chain: both parties funded)
 *         accepted → expired (funding window timeout)
 *         funded → active (on-chain: cron confirms funding)
 *         active → expired
 *         active → burned (dispute)
 *         delivered → burned (dispute)
 *
 * In Stripe mode (Phase 1), accept is atomic: proposed → active.
 * In on-chain mode (Phase 4), accept → accepted → funded → active.
 * Phase 2 adds automated verification: delivered → released / failed.
 */

export type EscrowStatus =
  | 'proposed'
  | 'accepted'     // on-chain: seller accepted, awaiting funding
  | 'funded'       // on-chain: both parties funded, awaiting activation
  | 'active'
  | 'delivered'
  | 'released'
  | 'failed'
  | 'burned'
  | 'expired'

export type EscrowAction =
  | 'accept'          // seller accepts + funds atomically (Stripe)
  | 'accept_onchain'  // seller accepts, contract deployed (on-chain)
  | 'fund'            // both parties funded (on-chain)
  | 'activate'        // cron confirms funding → active (on-chain)
  | 'deliver'         // seller submits deliverable
  | 'confirm'         // buyer confirms delivery
  | 'verify_pass'     // automated verification passed
  | 'verify_fail'     // automated verification failed
  | 'dispute'         // either party disputes
  | 'timeout'         // cron: expires_at reached

const TRANSITIONS: Record<string, EscrowStatus> = {
  'proposed:accept': 'active',
  'proposed:accept_onchain': 'accepted',
  'proposed:timeout': 'expired',
  'accepted:fund': 'funded',
  'accepted:timeout': 'expired',
  'funded:activate': 'active',
  'active:deliver': 'delivered',
  'active:dispute': 'burned',
  'active:timeout': 'expired',
  'delivered:confirm': 'released',
  'delivered:verify_pass': 'released',
  'delivered:verify_fail': 'failed',
  'delivered:dispute': 'burned',
}

/** Check if a transition is valid. */
export function canTransition(from: EscrowStatus, action: EscrowAction): boolean {
  return `${from}:${action}` in TRANSITIONS
}

/** Get the next status for a valid transition. Throws on invalid. */
export function nextStatus(from: EscrowStatus, action: EscrowAction): EscrowStatus {
  const key = `${from}:${action}`
  const next = TRANSITIONS[key]
  if (!next) {
    throw new Error(`Invalid transition: ${from} → ${action}`)
  }
  return next
}

/** Check if a status is terminal (no further transitions possible). */
export function isTerminal(status: EscrowStatus): boolean {
  return status === 'released' || status === 'failed' || status === 'burned' || status === 'expired'
}
