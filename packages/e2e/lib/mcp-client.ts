/**
 * MCP Subprocess Client
 *
 * Spawns the TrustThenVerify MCP server as a child process and communicates
 * via JSON-RPC 2.0 over stdin/stdout — identical to how Claude Desktop connects.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Path to compiled MCP server entry point
const MCP_DIST = resolve(__dirname, '..', '..', 'mcp', 'dist', 'index.js')

// ─── Types ──────────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

export interface McpToolResult {
  content: Array<{ type: string; text: string }>
  isError?: boolean
}

export interface McpConnectOptions {
  privateKey: string
  publicKey: string
  apiUrl: string
  /** Timeout per tool call in ms (default: 30000) */
  timeout?: number
}

// ─── McpClient ──────────────────────────────────────────────────────────────

export class McpClient {
  private proc: ChildProcess
  private nextId = 1
  private pending = new Map<number, {
    resolve: (v: unknown) => void
    reject: (e: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  private buffer = ''
  private timeout: number
  private closed = false

  private constructor(proc: ChildProcess, timeout: number) {
    this.proc = proc
    this.timeout = timeout

    proc.stdout!.setEncoding('utf-8')
    proc.stdout!.on('data', (chunk: string) => this.onData(chunk))

    proc.stderr!.setEncoding('utf-8')
    proc.stderr!.on('data', (chunk: string) => {
      // MCP server logs to stderr — useful for debugging
      for (const line of chunk.split('\n').filter(Boolean)) {
        if (process.env.MCP_DEBUG) console.error('[mcp-stderr]', line)
      }
    })

    proc.on('exit', (code) => {
      this.closed = true
      // Reject all pending requests
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error(`MCP server exited with code ${code}`))
        this.pending.delete(id)
      }
    })
  }

  /**
   * Spawn an MCP server and complete the initialize handshake.
   */
  static async connect(opts: McpConnectOptions): Promise<McpClient> {
    const proc = spawn('node', [MCP_DIST], {
      env: {
        ...process.env,
        TRUST_PRIVATE_KEY: opts.privateKey,
        TRUST_PUBLIC_KEY: opts.publicKey,
        TRUST_API_URL: opts.apiUrl,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // Wait for process to be ready (doesn't exit immediately)
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err)
      const onSpawn = () => {
        proc.removeListener('error', onError)
        resolve()
      }
      proc.once('spawn', onSpawn)
      proc.once('error', onError)
    })

    const client = new McpClient(proc, opts.timeout ?? 30_000)

    // MCP initialize handshake
    const initResult = await client.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e-test', version: '1.0.0' },
    })

    // Send initialized notification (no response expected)
    client.notify('notifications/initialized', {})

    return client
  }

  /**
   * Call an MCP tool by name with arguments.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    const result = await this.send('tools/call', { name, arguments: args }) as McpToolResult
    return result
  }

  /**
   * Call a tool and parse the JSON text content.
   */
  async callToolJson<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.callTool(name, args)
    if (result.isError) {
      throw new Error(`MCP tool ${name} failed: ${result.content?.[0]?.text ?? 'unknown error'}`)
    }
    const text = result.content?.[0]?.text
    if (!text) throw new Error(`MCP tool ${name} returned no content`)
    return JSON.parse(text) as T
  }

  /**
   * List all available tools.
   */
  async listTools(): Promise<Array<{ name: string; description: string }>> {
    const result = await this.send('tools/list', {}) as { tools: Array<{ name: string; description: string }> }
    return result.tools
  }

  /**
   * Gracefully close the MCP server.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true

    // Close stdin to signal EOF
    this.proc.stdin!.end()

    // Wait for exit (max 5s)
    await Promise.race([
      once(this.proc, 'exit'),
      new Promise(r => setTimeout(r, 5000)),
    ])

    // Force kill if still running
    if (!this.proc.killed) {
      this.proc.kill('SIGKILL')
    }
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private send(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('MCP client is closed'))

    const id = this.nextId++
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request ${method} timed out after ${this.timeout}ms`))
      }, this.timeout)

      this.pending.set(id, { resolve, reject, timer })
      this.proc.stdin!.write(JSON.stringify(request) + '\n')
    })
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (this.closed) return
    const notification: JsonRpcNotification = { jsonrpc: '2.0', method, params }
    this.proc.stdin!.write(JSON.stringify(notification) + '\n')
  }

  private onData(chunk: string): void {
    this.buffer += chunk

    // Process complete lines (newline-delimited JSON)
    let newlineIdx: number
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim()
      this.buffer = this.buffer.slice(newlineIdx + 1)

      if (!line) continue

      try {
        const msg = JSON.parse(line) as JsonRpcResponse
        if ('id' in msg && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!
          this.pending.delete(msg.id)
          clearTimeout(p.timer)

          if (msg.error) {
            p.reject(new Error(`JSON-RPC error ${msg.error.code}: ${msg.error.message}`))
          } else {
            p.resolve(msg.result)
          }
        }
        // Notifications (no id) are silently consumed
      } catch {
        // Non-JSON line (shouldn't happen on stdout with MCP)
        if (process.env.MCP_DEBUG) console.error('[mcp-stdout-parse-error]', line)
      }
    }
  }
}
