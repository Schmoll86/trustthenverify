import { describe, it, expect } from 'vitest'
import { canTransition, nextStatus, isTerminal } from '../lib/escrow-state'
import type { EscrowStatus, EscrowAction } from '../lib/escrow-state'

describe('Escrow state machine', () => {
  describe('canTransition', () => {
    const valid: Array<[EscrowStatus, EscrowAction]> = [
      ['proposed', 'accept'],
      ['proposed', 'timeout'],
      ['active', 'deliver'],
      ['active', 'dispute'],
      ['active', 'timeout'],
      ['delivered', 'confirm'],
      ['delivered', 'dispute'],
    ]

    for (const [from, action] of valid) {
      it(`allows ${from} → ${action}`, () => {
        expect(canTransition(from, action)).toBe(true)
      })
    }

    const invalid: Array<[EscrowStatus, EscrowAction]> = [
      ['proposed', 'deliver'],
      ['proposed', 'confirm'],
      ['proposed', 'dispute'],
      ['active', 'accept'],
      ['active', 'confirm'],
      ['delivered', 'accept'],
      ['delivered', 'deliver'],
      ['delivered', 'timeout'],
      ['released', 'accept'],
      ['released', 'dispute'],
      ['burned', 'confirm'],
      ['expired', 'accept'],
    ]

    for (const [from, action] of invalid) {
      it(`rejects ${from} → ${action}`, () => {
        expect(canTransition(from, action)).toBe(false)
      })
    }
  })

  describe('nextStatus', () => {
    it('proposed + accept → active', () => {
      expect(nextStatus('proposed', 'accept')).toBe('active')
    })
    it('proposed + timeout → expired', () => {
      expect(nextStatus('proposed', 'timeout')).toBe('expired')
    })
    it('active + deliver → delivered', () => {
      expect(nextStatus('active', 'deliver')).toBe('delivered')
    })
    it('active + dispute → burned', () => {
      expect(nextStatus('active', 'dispute')).toBe('burned')
    })
    it('active + timeout → expired', () => {
      expect(nextStatus('active', 'timeout')).toBe('expired')
    })
    it('delivered + confirm → released', () => {
      expect(nextStatus('delivered', 'confirm')).toBe('released')
    })
    it('delivered + dispute → burned', () => {
      expect(nextStatus('delivered', 'dispute')).toBe('burned')
    })
    it('throws on invalid transition', () => {
      expect(() => nextStatus('released', 'accept')).toThrow('Invalid transition')
    })
  })

  describe('isTerminal', () => {
    it('released is terminal', () => expect(isTerminal('released')).toBe(true))
    it('burned is terminal', () => expect(isTerminal('burned')).toBe(true))
    it('expired is terminal', () => expect(isTerminal('expired')).toBe(true))
    it('proposed is not terminal', () => expect(isTerminal('proposed')).toBe(false))
    it('active is not terminal', () => expect(isTerminal('active')).toBe(false))
    it('delivered is not terminal', () => expect(isTerminal('delivered')).toBe(false))
  })
})
