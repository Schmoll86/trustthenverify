#!/usr/bin/env node
// TrustThenVerify MCP Server — entry point
// Usage: TRUST_PRIVATE_KEY=<hex> trust-mcp

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { TrustProtocol } from '@trustthenverify/sdk'
import { createServer } from './server.js'

const apiUrl = process.env.TRUST_API_URL ?? 'http://localhost:8787'
const privateKey = process.env.TRUST_PRIVATE_KEY
const publicKey = process.env.TRUST_PUBLIC_KEY

if (!privateKey || !publicKey) {
  console.error('TRUST_PRIVATE_KEY and TRUST_PUBLIC_KEY are required')
  process.exit(1)
}

const protocol = new TrustProtocol({ apiUrl, privateKey, publicKey })
const server = createServer(protocol, apiUrl)

const transport = new StdioServerTransport()
await server.connect(transport)
