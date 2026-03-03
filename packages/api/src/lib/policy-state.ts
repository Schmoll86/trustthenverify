/**
 * Policy lifecycle state machine — pure functions per SPEC-v2 §3.
 *
 * States: draft → validated → approved → active → deprecated
 * Phase 2 shortcut: validated:activate → active (skip approved, no Argus yet).
 */

export type PolicyStatus = 'draft' | 'validated' | 'approved' | 'active' | 'stale' | 'deprecated'

export type PolicyAction = 'validate' | 'approve' | 'activate' | 'deprecate' | 'flag_stale'

const TRANSITIONS: Record<string, PolicyStatus> = {
  'draft:validate': 'validated',
  'validated:approve': 'approved',
  'validated:activate': 'active',   // Phase 2 shortcut
  'approved:activate': 'active',
  'active:deprecate': 'deprecated',
  'active:flag_stale': 'stale',     // Cron flags high-dispute policies (§3.1.3)
  'stale:activate': 'active',       // Creator refines and re-activates
  'stale:deprecate': 'deprecated',
}

export function canTransitionPolicy(from: PolicyStatus, action: PolicyAction): boolean {
  return `${from}:${action}` in TRANSITIONS
}

export function nextPolicyStatus(from: PolicyStatus, action: PolicyAction): PolicyStatus {
  const key = `${from}:${action}`
  const next = TRANSITIONS[key]
  if (!next) {
    throw new Error(`Invalid policy transition: ${from} → ${action}`)
  }
  return next
}

export function isPolicyTerminal(status: PolicyStatus): boolean {
  return status === 'deprecated'
}

export function isPolicyUsable(status: PolicyStatus): boolean {
  return status === 'active' // stale policies can't be used for new escrows
}
