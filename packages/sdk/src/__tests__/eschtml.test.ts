/**
 * Tests for escHtml() — mirrors packages/landing/ttv-lib.js:escHtml().
 * Copied here as a pure function to avoid adding vitest to the landing package.
 */
import { describe, it, expect } from 'vitest'

// Mirror of escHtml from packages/landing/ttv-lib.js (line 220-223)
function escHtml(str: unknown): string {
  if (str == null) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

describe('escHtml (mirrors packages/landing/ttv-lib.js)', () => {
  it('escapes & to &amp;', () => {
    expect(escHtml('a&b')).toBe('a&amp;b')
  })

  it('escapes < to &lt;', () => {
    expect(escHtml('a<b')).toBe('a&lt;b')
  })

  it('escapes > to &gt;', () => {
    expect(escHtml('a>b')).toBe('a&gt;b')
  })

  it('escapes " to &quot;', () => {
    expect(escHtml('a"b')).toBe('a&quot;b')
  })

  it("escapes ' to &#39;", () => {
    expect(escHtml("a'b")).toBe('a&#39;b')
  })

  it('escapes all entities in a single mixed string', () => {
    expect(escHtml('a & b < c > d " e \' f')).toBe(
      'a &amp; b &lt; c &gt; d &quot; e &#39; f',
    )
  })

  it('returns empty string for null', () => {
    expect(escHtml(null)).toBe('')
  })

  it('returns empty string for undefined', () => {
    expect(escHtml(undefined)).toBe('')
  })

  it('converts number to string', () => {
    expect(escHtml(42)).toBe('42')
  })

  it('neutralizes <script>alert("xss")</script>', () => {
    expect(escHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    )
  })
})
