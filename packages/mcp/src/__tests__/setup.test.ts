import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Run setup as a subprocess to test the CLI entrypoint.
// We override HOME so keypair.json lands in a temp dir.

const BIN = join(__dirname, '..', 'index.ts')

describe('setup CLI', () => {
  let tempHome: string

  beforeEach(() => {
    tempHome = join(tmpdir(), `trust-mcp-test-${Date.now()}`)
    mkdirSync(tempHome, { recursive: true })
  })

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true })
  })

  it('generates keypair and outputs config JSON', () => {
    const result = execFileSync('npx', ['tsx', BIN, 'setup'], {
      env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
      encoding: 'utf-8',
      timeout: 15_000,
    })

    // stdout should be valid JSON with mcpServers config
    const config = JSON.parse(result)
    expect(config.mcpServers).toBeDefined()
    expect(config.mcpServers['trust-then-verify']).toBeDefined()

    const serverConfig = config.mcpServers['trust-then-verify']
    expect(serverConfig.env.TRUST_PRIVATE_KEY).toMatch(/^[0-9a-f]{64}$/)
    expect(serverConfig.env.TRUST_PUBLIC_KEY).toMatch(/^0[23][0-9a-f]{64}$/)
    expect(serverConfig.env.TRUST_API_URL).toBe('https://sandbox.trustthenverify.com/v2')

    // Keypair file should exist
    const keypairPath = join(tempHome, '.trustthenverify', 'keypair.json')
    expect(existsSync(keypairPath)).toBe(true)

    const saved = JSON.parse(readFileSync(keypairPath, 'utf-8'))
    expect(saved.publicKey).toBe(serverConfig.env.TRUST_PUBLIC_KEY)
    expect(saved.privateKey).toBe(serverConfig.env.TRUST_PRIVATE_KEY)
  })

  it('reuses existing keypair on re-run', () => {
    // First run
    const result1 = execFileSync('npx', ['tsx', BIN, 'setup'], {
      env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
      encoding: 'utf-8',
      timeout: 15_000,
    })

    // Second run
    const result2 = execFileSync('npx', ['tsx', BIN, 'setup'], {
      env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
      encoding: 'utf-8',
      timeout: 15_000,
    })

    const config1 = JSON.parse(result1)
    const config2 = JSON.parse(result2)

    // Same keys both times
    expect(config2.mcpServers['trust-then-verify'].env.TRUST_PRIVATE_KEY)
      .toBe(config1.mcpServers['trust-then-verify'].env.TRUST_PRIVATE_KEY)
    expect(config2.mcpServers['trust-then-verify'].env.TRUST_PUBLIC_KEY)
      .toBe(config1.mcpServers['trust-then-verify'].env.TRUST_PUBLIC_KEY)
  })
})
