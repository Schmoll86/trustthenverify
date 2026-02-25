import { describe, it, expect } from 'vitest'
import { canTransitionPolicy, nextPolicyStatus, isPolicyTerminal } from '../lib/policy-state'

describe('Policy state machine', () => {
  describe('canTransitionPolicy', () => {
    it('allows draft → validate → validated', () => {
      expect(canTransitionPolicy('draft', 'validate')).toBe(true)
    })

    it('allows validated → approve → approved', () => {
      expect(canTransitionPolicy('validated', 'approve')).toBe(true)
    })

    it('allows validated → activate → active (Phase 2 shortcut)', () => {
      expect(canTransitionPolicy('validated', 'activate')).toBe(true)
    })

    it('allows approved → activate → active', () => {
      expect(canTransitionPolicy('approved', 'activate')).toBe(true)
    })

    it('allows active → deprecate → deprecated', () => {
      expect(canTransitionPolicy('active', 'deprecate')).toBe(true)
    })

    it('rejects draft → activate', () => {
      expect(canTransitionPolicy('draft', 'activate')).toBe(false)
    })

    it('rejects deprecated → activate', () => {
      expect(canTransitionPolicy('deprecated', 'activate')).toBe(false)
    })

    it('rejects active → validate', () => {
      expect(canTransitionPolicy('active', 'validate')).toBe(false)
    })
  })

  describe('nextPolicyStatus', () => {
    it('returns validated for draft:validate', () => {
      expect(nextPolicyStatus('draft', 'validate')).toBe('validated')
    })

    it('returns active for validated:activate', () => {
      expect(nextPolicyStatus('validated', 'activate')).toBe('active')
    })

    it('returns active for approved:activate', () => {
      expect(nextPolicyStatus('approved', 'activate')).toBe('active')
    })

    it('returns deprecated for active:deprecate', () => {
      expect(nextPolicyStatus('active', 'deprecate')).toBe('deprecated')
    })

    it('throws on invalid transition', () => {
      expect(() => nextPolicyStatus('draft', 'activate')).toThrow('Invalid policy transition')
    })
  })

  describe('isPolicyTerminal', () => {
    it('deprecated is terminal', () => {
      expect(isPolicyTerminal('deprecated')).toBe(true)
    })

    it('active is not terminal', () => {
      expect(isPolicyTerminal('active')).toBe(false)
    })

    it('draft is not terminal', () => {
      expect(isPolicyTerminal('draft')).toBe(false)
    })
  })
})
