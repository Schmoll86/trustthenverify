# MCP Registry Submissions — Drafts (pending co-sign)

These are drafts for the two main MCP server registries. Ryan needs to co-sign
before either is filed — the registries require domain/GitHub ownership proof,
and in the case of glama.ai, account creation.

## 1. Official MCP Registry (`registry.modelcontextprotocol.io`)

This is the Model Context Protocol steering group's registry. Preview as of
2026-04-21. Submission is via the `mcp-publisher` CLI tool against a `server.json`
manifest. Authentication is GitHub-OAuth (publisher's GitHub account controls
the `io.github.<handle>/*` namespace).

### Proposed `server.json`

Put this file at `packages/mcp/server.json` (new). It references the already-published
`@trustthenverify/mcp@0.3.0` on npm.

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.Schmoll86/trustthenverify",
  "title": "TrustThenVerify",
  "description": "Escrow + x402 USDC payment rail for autonomous AI agents. Formal policy verification, LLM-arbitrated disputes, oracle consensus. Base L2.",
  "websiteUrl": "https://trustthenverify.com",
  "repository": {
    "url": "https://github.com/Schmoll86/trustthenverify",
    "source": "github",
    "subfolder": "packages/mcp"
  },
  "version": "0.3.0",
  "packages": [
    {
      "registryType": "npm",
      "registryBaseUrl": "https://registry.npmjs.org",
      "identifier": "@trustthenverify/mcp",
      "version": "0.3.0",
      "transport": {
        "type": "stdio"
      },
      "environmentVariables": [
        {
          "name": "TRUST_API_URL",
          "description": "TTV API base URL. Defaults to sandbox (https://sandbox.trustthenverify.com/v2). Set to https://api.trustthenverify.com/v2 to go live.",
          "isRequired": false,
          "isSecret": false
        },
        {
          "name": "TRUST_PRIVATE_KEY",
          "description": "Optional: hex-encoded secp256k1 private key. If absent, the MCP auto-generates one at ~/.trustthenverify/keypair.json on first run.",
          "isRequired": false,
          "isSecret": true
        }
      ]
    }
  ],
  "_meta": {
    "io.modelcontextprotocol.registry/publisher-provided": {
      "tool": "manual",
      "protocol": "x402",
      "chains": ["eip155:8453"],
      "facilitator_manifest": "https://api.trustthenverify.com/.well-known/x402.json",
      "tools_count": 46,
      "primary_tool": "trust_x402_buy"
    }
  }
}
```

### Prerequisites — things we need before submitting

1. **Add `mcpName` to `packages/mcp/package.json`**. Current package.json does not have it.
   ```diff
      "name": "@trustthenverify/mcp",
      "version": "0.3.0",
   +  "mcpName": "io.github.Schmoll86/trustthenverify",
      "type": "module",
   ```
   Then bump to `0.3.1` and republish. The registry validates by reading `mcpName`
   from the published npm package to prove publisher controls both.

2. **Install `mcp-publisher` CLI.** Either via Homebrew (`brew install mcp-publisher`)
   or the pre-built binary. Ryan does this locally, on a machine where he can
   complete GitHub-OAuth.

3. **Run submission.** From the repo:
   ```bash
   cd packages/mcp
   mcp-publisher login github
   mcp-publisher publish server.json
   ```
   OAuth flow proves Ryan owns the `Schmoll86` GitHub handle → registry accepts
   the `io.github.Schmoll86/*` namespace.

### What we're NOT deciding yet

- **Namespace choice.** `io.github.Schmoll86/trustthenverify` is the path-of-least-
  resistance because GitHub-OAuth just works. We could instead claim
  `com.trustthenverify/mcp` via domain verification on trustthenverify.com.
  That's cleaner long-term but requires adding a TXT record and going through
  the domain-verification flow. Recommendation: start with GitHub namespace,
  migrate to the domain namespace later if it matters.

### Action checklist

- [ ] Add `mcpName` field to `packages/mcp/package.json`
- [ ] Bump to `@trustthenverify/mcp@0.3.1` + republish npm
- [ ] Copy `server.json` above to `packages/mcp/server.json`
- [ ] `brew install mcp-publisher` (or download binary)
- [ ] `mcp-publisher login github`
- [ ] `mcp-publisher publish packages/mcp/server.json`
- [ ] Verify listing appears at `https://registry.modelcontextprotocol.io/v0/servers?q=trustthenverify`

## 2. Glama MCP Registry (`glama.ai/mcp/servers`)

Glama hosts 21,900+ MCP servers and is a major discovery surface. The exact
submission mechanism is not documented on the public-facing site — the "Add Server"
button routes through glama.ai's auth. Probable options: (a) submit a GitHub
repo URL and let their crawler auto-index, (b) file a PR against a public
manifest repo.

### Proposed copy

For the "submit a server" form (whatever shape it turns out to be), use:

- **Name:** TrustThenVerify
- **Author:** Schmoll86 / FindSquad, Inc.
- **Repository:** `https://github.com/Schmoll86/trustthenverify`
- **Install:** `claude mcp add trustthenverify -- npx -y @trustthenverify/mcp`
- **npm:** `https://www.npmjs.com/package/@trustthenverify/mcp`
- **License:** MIT
- **Language:** TypeScript
- **Description:** Escrow + x402 USDC payment rail for autonomous AI agents. Formal policy verification, LLM-arbitrated disputes, oracle consensus. Base L2.
- **Categories/tags:** `payments`, `escrow`, `blockchain`, `x402`, `usdc`, `agentic-commerce`, `base-mainnet`, `verification`
- **Long description:**

  > TrustThenVerify (TTV) is an escrow-backed payment rail built for AI agents
  > to transact with each other. It implements the x402 protocol for USDC
  > settlement on Base L2 and layers game-theoretic primitives on top:
  > collateral staking, adversarial policy refinement (Argus), oracle pools,
  > macaroon receipts, LLM dispute arbitration. The MCP server exposes 46
  > tools; the primary one, `trust_x402_buy`, wraps the full propose → pay →
  > wait → confirm loop in a single call. Facilitator manifest is at
  > `api.trustthenverify.com/.well-known/x402.json`.

### Action checklist

- [ ] Sign in to glama.ai (Google or GitHub)
- [ ] Click "Add Server" → fill in the form with the copy above
- [ ] Submit; wait for moderation
- [ ] Once listed, verify the Glama page shows the current tool count and install command

### What we're NOT deciding yet

- **Screenshots / promo.** If Glama supports them, defer to a follow-up once we
  have a working dashboard or live demo. For v1 submission, text-only is fine.

## 3. Monitoring cadence

After submission, re-check quarterly:

- **Official registry:** `curl -s https://registry.modelcontextprotocol.io/v0/servers?q=trustthenverify | jq` — confirms version, tool count, status = active.
- **Glama:** browse the listing. If the Glama page shows stale data, re-submit with current version.

Do not submit yet — this file is the draft. Ryan co-signs before actual
submission.
