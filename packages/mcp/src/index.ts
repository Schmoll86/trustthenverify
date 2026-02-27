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
  const apiUrl = process.env.TRUST_API_URL ?? 'http://localhost:8787'
  const privateKey = process.env.TRUST_PRIVATE_KEY
  const publicKey = process.env.TRUST_PUBLIC_KEY

  if (!privateKey || !publicKey) {
    console.error('TRUST_PRIVATE_KEY and TRUST_PUBLIC_KEY are required')
    console.error('Run `npx @trustthenverify/mcp setup` to generate keys automatically')
    process.exit(1)
  }

  // Auto-register agent (idempotent — 409 if already registered)
  try {
    const isSandbox = apiUrl.includes('sandbox')
    await createAgent({ publicKey, privateKey, apiUrl, sandbox: isSandbox, name: 'mcp-agent' })
    console.error('[trust-mcp] Agent registered: ' + publicKey.slice(0, 16) + '...')
  } catch {
    // Already registered (409) or network issue — tools will surface real errors
  }

  const protocol = new TrustProtocol({ apiUrl, privateKey, publicKey })
  const server = createServer(protocol, apiUrl)

  const transport = new StdioServerTransport()
  await server.connect(transport)
}
