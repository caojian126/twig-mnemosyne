/** MCP Gateway HTTP 客户端（§5.4）。gateway 永不持有 DB 凭证，工具执行走这里。 */
import { env } from '../config.js'

export class McpGatewayError extends Error {
  constructor(message: string) {
    super(message.slice(0, 500))
    this.name = 'McpGatewayError'
  }
}

export interface GatewayToolInfo {
  server: string
  name: string
  description: string
  input_schema: unknown
}

/** /tools 响应页：工具聚合 + 每 server 的 skill_document（使用说明，逐 server 不逐工具） */
export interface GatewayToolsPage {
  tools: GatewayToolInfo[]
  skillDocuments: Record<string, string>
}

export class McpGatewayClient {
  constructor(private readonly baseUrl = env.MCP_GATEWAY_URL) {}

  /** 网关配置了共享密钥时所有端点（含 /tools）都要票——dev 未配置则不带 */
  private headers(): Record<string, string> {
    return env.BROKER_INTERNAL_TOKEN.length > 0 ? { 'X-Broker-Token': env.BROKER_INTERNAL_TOKEN } : {}
  }

  async listTools(): Promise<GatewayToolsPage> {
    const res = await fetch(`${this.baseUrl}/tools`, { headers: this.headers(), signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new McpGatewayError(`tools ${res.status}`)
    const data = (await res.json()) as { tools?: GatewayToolInfo[]; skill_documents?: Record<string, string> }
    return { tools: data.tools ?? [], skillDocuments: data.skill_documents ?? {} }
  }

  /** 短超时探活（/health 与启动自检用；listTools 的 15s 超时太拖）。返回工具数。 */
  async ping(): Promise<number> {
    const res = await fetch(`${this.baseUrl}/tools`, { headers: this.headers(), signal: AbortSignal.timeout(3_000) })
    if (!res.ok) throw new McpGatewayError(`tools ${res.status}`)
    const data = (await res.json()) as { tools?: GatewayToolInfo[] }
    return data.tools?.length ?? 0
  }

  /** 网关 /health：per-server connected / tools / last_error（forge 页数据源）。 */
  async getHealth(): Promise<{ ok: boolean; servers: { name: string; type: string; enabled: boolean; connected: boolean; tools: number | null; last_error: string | null }[] }> {
    const res = await fetch(`${this.baseUrl}/health`, { headers: this.headers(), signal: AbortSignal.timeout(5_000) })
    if (!res.ok) throw new McpGatewayError(`health ${res.status}`)
    return (await res.json()) as { ok: boolean; servers: { name: string; type: string; enabled: boolean; connected: boolean; tools: number | null; last_error: string | null }[] }
  }

  async call(server: string, tool: string, args: Record<string, unknown>): Promise<string> {
    const res = await fetch(`${this.baseUrl}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers() },
      body: JSON.stringify({ server, tool, args }),
      signal: AbortSignal.timeout(60_000),
    })
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; content?: string; error?: string }
    if (!res.ok || !data.ok) throw new McpGatewayError(data.error ?? `call ${res.status}`)
    return data.content ?? ''
  }
}
