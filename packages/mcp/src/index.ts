#!/usr/bin/env node
// TrustThenVerify MCP Server — entry point
// Usage: TRUST_PRIVATE_KEY=<hex> trust-mcp
// Setup: npx @trustthenverify/mcp setup

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { TrustProtocol, generateKeypair, createAgent } from '@trustthenverify/sdk'
import { createServer } from './server.js'

// ── Setup CLI ────────────────────────────────────────────────────────────────

if (process.argv[2] === 'setup') {
  await runSetup()
} else {
  await startServer()
}

// ── Setup command ────────────────────────────────────────────────────────────

async function runSetup() {
  const { writeFileSync, mkdirSync, readFileSync, existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')

  const configDir = join(homedir(), '.trustthenverify')
  const keypairPath = join(configDir, 'keypair.json')

  let publicKey: string
  let privateKey: string

  if (existsSync(keypairPath)) {
    // Reuse existing keypair
    const saved = JSON.parse(readFileSync(keypairPath, 'utf-8'))
    publicKey = saved.publicKey
    privateKey = saved.privateKey
    console.error('[setup] Reusing existing keypair from ' + keypairPath)
  } else {
    // Generate new keypair
    const kp = generateKeypair()
    publicKey = kp.publicKey
    privateKey = kp.privateKey

    mkdirSync(configDir, { recursive: true, mode: 0o700 })
    writeFileSync(keypairPath, JSON.stringify({ publicKey, privateKey }, null, 2), { mode: 0o600 })
    console.error('[setup] Keypair saved to ' + keypairPath)
  }

  // Register on sandbox
  try {
    await createAgent({ publicKey, privateKey, apiUrl: 'https://sandbox.trustthenverify.com/v2', sandbox: false })
    console.error('[setup] Agent registered on sandbox')
  } catch {
    console.error('[setup] Agent already registered (or network unavailable)')
  }

  // Print config JSON to stdout (ready to paste)
  const config = {
    mcpServers: {
      'trust-then-verify': {
        command: 'npx',
        args: ['-y', '@trustthenverify/mcp'],
        env: {
          TRUST_PRIVATE_KEY: privateKey,
          TRUST_PUBLIC_KEY: publicKey,
          TRUST_API_URL: 'https://sandbox.trustthenverify.com/v2',
        },
      },
    },
  }

  // Config JSON goes to stdout (machine-readable)
  console.log(JSON.stringify(config, null, 2))

  // Instructions go to stderr (human-readable)
  console.error('')
  console.error('Add the JSON above to your MCP host config:')
  console.error('  Claude Desktop: ~/Library/Application Support/Claude/claude_desktop_config.json')
  console.error('  Cursor:         .cursor/mcp.json (project) or ~/.cursor/mcp.json (global)')
  console.error('  Claude Code:    .mcp.json (project) or ~/.claude/mcp.json (global)')
  console.error('')
  console.error('To switch to production, change TRUST_API_URL to https://api.trustthenverify.com/v2')
}

// ── Server startup ───────────────────────────────────────────────────────────

async function startServer() {
  const { privateKey, publicKey, apiUrl, ethAddress, source } = await resolveCredentials()

  // Auto-register agent (idempotent — 409 if already registered)
  try {
    const isSandbox = apiUrl.includes('sandbox')
    await createAgent({ publicKey, privateKey, apiUrl, sandbox: isSandbox, name: 'mcp-agent' })
  } catch {
    // Already registered (409) or network issue — tools will surface real errors
  }

  // Startup banner — prints to stderr so MCP protocol (stdout) is undisturbed.
  // This is the first thing the user sees: WHO they are, WHERE they need to
  // fund, HOW to pay. Without this, zero-config onboarding leaves the agent
  // confused about where their money should go.
  console.error('')
  console.error('─── TrustThenVerify MCP ───')
  console.error(`  Agent pubkey : ${publicKey.slice(0, 24)}...`)
  console.error(`  ETH address  : ${ethAddress}  ← fund USDC + ETH here (Base L2, chain 8453)`)
  console.error(`  API          : ${apiUrl}`)
  console.error(`  Key source   : ${source}`)
  if (source === 'generated') {
    console.error('')
    console.error('  🆕 New keypair generated at ~/.trustthenverify/keypair.json (0600).')
    console.error('     To pay other agents, send USDC + a small amount of ETH for gas')
    console.error('     on BASE MAINNET to the address above. Set TRUST_API_URL to')
    console.error('     https://api.trustthenverify.com/v2 when ready for real-money mode.')
    console.error('     Coinbase path: coinbase.com → Send → USDC → Network: Base → paste.')
  }
  console.error('')

  const protocol = new TrustProtocol({ apiUrl, privateKey, publicKey })
  const server = createServer(protocol, apiUrl)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

// ── Credential resolution ────────────────────────────────────────────────────

/**
 * Resolve agent credentials in priority order:
 *   1. env vars TRUST_PRIVATE_KEY + TRUST_PUBLIC_KEY (explicit caller config)
 *   2. ~/.trustthenverify/keypair.json (previous run / post-setup)
 *   3. auto-generate a new keypair and save it to (2)
 *
 * Default API URL: prod if env/file keys exist, sandbox if we had to
 * auto-generate (safer first-run — unfunded wallet, free to experiment).
 */
async function resolveCredentials(): Promise<{
  privateKey: string
  publicKey: string
  apiUrl: string
  ethAddress: string
  source: 'env' | 'keypair.json' | 'generated'
}> {
  const { privateKeyToEthAddress } = await import('@trustthenverify/sdk')

  const envPriv = process.env.TRUST_PRIVATE_KEY
  const envPub = process.env.TRUST_PUBLIC_KEY
  if (envPriv && envPub) {
    const apiUrl = process.env.TRUST_API_URL ?? 'https://api.trustthenverify.com/v2'
    return {
      privateKey: envPriv,
      publicKey: envPub,
      apiUrl,
      ethAddress: privateKeyToEthAddress(envPriv),
      source: 'env',
    }
  }

  const { readFileSync, writeFileSync, mkdirSync, existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')

  const configDir = join(homedir(), '.trustthenverify')
  const keypairPath = join(configDir, 'keypair.json')

  if (existsSync(keypairPath)) {
    const saved = JSON.parse(readFileSync(keypairPath, 'utf-8')) as {
      publicKey: string
      privateKey: string
    }
    const apiUrl = process.env.TRUST_API_URL ?? 'https://api.trustthenverify.com/v2'
    return {
      privateKey: saved.privateKey,
      publicKey: saved.publicKey,
      apiUrl,
      ethAddress: privateKeyToEthAddress(saved.privateKey),
      source: 'keypair.json',
    }
  }

  const kp = generateKeypair()
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  writeFileSync(
    keypairPath,
    JSON.stringify({ publicKey: kp.publicKey, privateKey: kp.privateKey }, null, 2),
    { mode: 0o600 },
  )
  const apiUrl = process.env.TRUST_API_URL ?? 'https://sandbox.trustthenverify.com/v2'
  return {
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    apiUrl,
    ethAddress: privateKeyToEthAddress(kp.privateKey),
    source: 'generated',
  }
}
