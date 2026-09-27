/**
 * Mnemosyne MCP Gateway（§5）—— 轻量 MCP 客户端聚合器。
 *
 * 与 eznix86 fork 的关系（NOTICE.md 已注记）：鸦巢网关（qimingjiu/mcp-gateway）已演化成
 * TG 陪伴 bot，不再承担工具路由职责；本服务为 Mnemosyne 专用重建，保留原扩展语义：
 * 懒连接（首次使用才建连）、动态聚合 tools、skill_document 透传。
 *
 * 铁律（§5.3 / VULN-08）：本服务永不接触 DB、ENCRYPTION_KEY、长期 refresh token。
 * OAuth 凭证经 Runtime 的 Token Broker 短票取件（TODO：随首个 OAuth 型远程 MCP server 接入）。
 *
 * 内置 server「core」保证任何部署都有一个可 E2E 验证的工具（get_current_time）。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { BUILTIN_SERVERS, installBuiltin, type ToolInfo } from './builtin.js'

const PORT = Number(process.env.PORT || 3000)
const CONFIG_PATH = process.env.MCP_CONFIG_PATH || 'config.default.json'
/**
 * 内部共享密钥（与 Runtime 同源 env，恒时比较在长密钥下足够）：配置后 /register /unregister
 * /call /tools 全部要求 X-Broker-Token——Zeabur 私有网内任何服务都能打到本网关，
 * 无鉴权的 /register 等于把「注册 remote server（SSRF 跳板）+ 污染工具面」开给全网。
 * 未配置（本地 dev）保持开放，但启动时告警一次，不留「为什么线上裸奔」的谜题。
 */
/** 惰性读取：测试可在运行时切换开关态；进程内不再缓存。 */
function authToken(): string {
  return process.env.BROKER_INTERNAL_TOKEN || ''
}

function checkAuth(req: IncomingMessage): boolean {
  if (!authToken()) return true
  return req.headers['x-broker-token'] === authToken()
}

interface ServerConfig {
  type: 'builtin' | 'local' | 'remote'
  command?: string[]
  url?: string
  enabled?: boolean
  skill_document?: string
  headers?: Record<string, string>
  /** 动态注册的 remote server 实际连接成功用的传输方式（register 时探测一次记入） */
  transport?: 'streamable-http' | 'sse'
}

interface GatewayConfig {
  mcpServers: Record<string, ServerConfig>
}

/** 运行时动态注册的 remote server（register/unregister 端点维护；快照持久化，重启读回） */
const dynamicServers = new Map<string, ServerConfig & { name: string }>()

// ── 注册表快照（write-through）────────────────────────────────────────────
// 此前动态注册只活在内存，重启即蒸发（121 个 Smithery 工具随滚动部署蒸发过）。
// MCP_BOOT_REGISTRATIONS 是第一条路（env 清单）；快照是第二条路：注册/注销即写盘，
// 启动读回并标记「已知未验证」——连接仍是懒的，首次调用时重握手，握不上的进
// lastError 尸检名单（/health 可见），绝不静默丢。文件含 headers（Bearer token），
// 只落容器卷，不入 git；写失败降级为纯内存（只读 fs 的部署形态照常工作）。
const STATE_PATH = process.env.MCP_STATE_PATH || 'dynamic-servers.json'

function saveSnapshot(): void {
  const list = [...dynamicServers.values()].map(({ name, url, headers, skill_document, transport }) =>
    ({ name, url, headers, skill_document, transport }))
  try {
    writeFileSync(STATE_PATH, JSON.stringify(list, null, 1))
  } catch (e) {
    console.error('[gateway] snapshot write failed (continuing in-memory):', e instanceof Error ? e.message : e)
  }
}

function loadSnapshot(): void {
  let list: (ServerConfig & { name: string })[]
  try {
    list = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as typeof list
  } catch {
    return // 无快照/损坏 → 空启动
  }
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item?.name !== 'string' || typeof item?.url !== 'string') continue
    if (dynamicServers.has(item.name)) continue // BOOT_REGISTRATIONS / 本次会话已注册者优先
    dynamicServers.set(item.name, {
      name: item.name, type: 'remote', url: item.url, enabled: true,
      transport: item.transport, skill_document: item.skill_document, headers: item.headers,
    })
    console.log(`[gateway] restored ${item.name} from snapshot (known-unverified, lazy re-handshake)`)
  }
}

function loadConfig(): GatewayConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as GatewayConfig
  } catch (e) {
    // 静默回退会让线上只剩「为什么我的 server 全没了」的谜题——原因必须可见
    console.error(`[gateway] config load failed (${CONFIG_PATH}):`, e instanceof Error ? e.message : e,
      '— falling back to builtin core only')
    return { mcpServers: { core: { type: 'builtin' } } }
  }
}

const config = loadConfig()

// ── 懒连接注册表 ────────────────────────────────────────────────────────────
interface Conn {
  client: Client
  connectedAt: number
}

const conns = new Map<string, Conn>()
/** 单飞守卫：冷启动并发调用若各自建连，输家的子进程/连接没人回收（泄漏） */
const connecting = new Map<string, Promise<Conn>>()
const toolsCache = new Map<string, { tools: ToolInfo[]; at: number }>()
// 每 server 最近一次故障，/health 透出（listTools 失败不再只沉在日志里）
const lastError = new Map<string, string>()
const TOOLS_TTL_MS = Number(process.env.MCP_TOOLS_TTL_MS || 60_000)
const CALL_TIMEOUT_MS = Number(process.env.MCP_CALL_TIMEOUT_MS || 60_000)

// ── 调用指标（内存计数；/metrics Prometheus 文本）──────────────────────────
// forge 页「今日调用 N · err M」此前无处可取——没有计量就没有可观测
const callStats = new Map<string, { calls: number; errors: number; latencyMs: number }>()

function recordCallStat(server: string, tool: string, latencyMs: number, failed: boolean): void {
  const key = `${server}/${tool}`
  const cur = callStats.get(key) ?? { calls: 0, errors: 0, latencyMs: 0 }
  cur.calls++
  if (failed) cur.errors++
  cur.latencyMs += latencyMs
  callStats.set(key, cur)
}

function renderPromMetrics(): string {
  const lines: string[] = []
  let total = 0, totalErr = 0
  for (const [key, s] of callStats) {
    const [server, tool] = key.split('/')
    total += s.calls
    totalErr += s.errors
    lines.push(`mcp_gateway_tool_calls_total{server="${server}",tool="${tool}"} ${s.calls}`)
    lines.push(`mcp_gateway_tool_errors_total{server="${server}",tool="${tool}"} ${s.errors}`)
    lines.push(`mcp_gateway_tool_latency_ms_sum{server="${server}",tool="${tool}"} ${s.latencyMs}`)
  }
  lines.push(`mcp_gateway_tool_calls_total{server="_all",tool="_all"} ${total}`)
  lines.push(`mcp_gateway_tool_errors_total{server="_all",tool="_all"} ${totalErr}`)
  return `# TYPE mcp_gateway_tool_calls_total counter\n# TYPE mcp_gateway_tool_errors_total counter\n# TYPE mcp_gateway_tool_latency_ms_sum counter\n${lines.join('\n')}\n`
}

function serverConfig(name: string): ServerConfig | undefined {
  return config.mcpServers[name] ?? dynamicServers.get(name)
}

/**
 * remote 传输探测（pi-mcp 借鉴）：顺序尝试 Streamable HTTP → SSE，谁先建连成功用谁。
 * 旧 MCP 服务多半只实现了 SSE；新协议绝大多数人只跑 Streamable HTTP——两边各试一次就分清了。
 */
async function probeRemote(url: string, headers?: Record<string, string>): Promise<{ client: Client; transport: 'streamable-http' | 'sse' }> {
  const target = new URL(url)
  const client = new Client({ name: 'mnemosyne-mcp-gateway', version: '1.0.0' })
  try {
    // TODO(broker): OAuth 型远程 server 在此注入 Broker 短票 header（§5.3）
    await client.connect(new StreamableHTTPClientTransport(target, { requestInit: { headers } }))
    return { client, transport: 'streamable-http' }
  } catch (err) {
    await client.close().catch(() => undefined)
    const sseClient = new Client({ name: 'mnemosyne-mcp-gateway', version: '1.0.0' })
    try {
      await sseClient.connect(new SSEClientTransport(target, { requestInit: { headers } }))
      return { client: sseClient, transport: 'sse' }
    } catch (sseErr) {
      await sseClient.close().catch(() => undefined)
      const a = err instanceof Error ? err.message : String(err)
      const b = sseErr instanceof Error ? sseErr.message : String(sseErr)
      throw new Error(`remote connect failed (streamable-http: ${a}; sse: ${b})`)
    }
  }
}

async function getConnection(server: string): Promise<Conn> {
  const existing = conns.get(server)
  if (existing) return existing
  const inFlight = connecting.get(server)
  if (inFlight) return inFlight
  const p = connect(server).finally(() => connecting.delete(server))
  connecting.set(server, p)
  return p
}

async function connect(server: string): Promise<Conn> {
  const cfg = serverConfig(server)
  if (!cfg || cfg.enabled === false) throw new Error(`server disabled or unknown: ${server}`)
  if (isBuiltin(server)) throw new Error('builtin handled directly, never via getConnection')

  let client: Client
  if (cfg.type === 'local' && cfg.command) {
    const [command, ...args] = cfg.command
    if (!command) throw new Error(`bad command for ${server}`)
    const local = new Client({ name: 'mnemosyne-mcp-gateway', version: '1.0.0' })
    await local.connect(new StdioClientTransport({ command, args, stderr: 'ignore' }))
    client = local
  } else if (cfg.type === 'remote' && cfg.url) {
    client = (await probeRemote(cfg.url, cfg.headers)).client
  } else {
    throw new Error(`bad server config: ${server}`)
  }

  const conn: Conn = { client, connectedAt: Date.now() }
  conns.set(server, conn)
  return conn
}

/**
 * 断连清理 + 懒重连（pi-mcp 借鉴）：辅助线程每 30s ping 一次非内置连接，
 * 失败就丢出 conn（下次 use 时自动重建）。校验：配置 static / dynamic map 都不动。
 */
async function checkHealth(): Promise<void> {
  const names = [...Object.keys(config.mcpServers), ...dynamicServers.keys()]
  for (const name of names) {
    if (isBuiltin(name)) continue
    const conn = conns.get(name)
    if (!conn) continue
    try {
      await Promise.race([conn.client.listTools(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5_000))])
      lastError.delete(name)
    } catch (e) {
      conns.delete(name)
      toolsCache.delete(name)
      await conn.client.close().catch(() => undefined)
      lastError.set(name, e instanceof Error ? e.message : String(e))
      console.error(`[gateway] health check dropped ${name}:`, e instanceof Error ? e.message : e)
    }
  }
}

// ── 动态注册（pi-mcp 借鉴：URL 必须显式给出）────────────────────────────────

/** 动态注册 remote server：URL 必填、可探测 transmissions、oauth/skill_document 可选省略。 */
async function registerServer(
  name: string,
  url: string,
  opts: { oauth?: boolean; skill_document?: string; headers?: Record<string, string> } = {},
): Promise<{ name: string; transport: 'streamable-http' | 'sse'; tools: ToolInfo[] }> {
  // builtin override：同名 builtin 会永久遮蔽 dynamic 定义，注册前就拒掉。
  // 名称格式与 /register 端点同一把尺（register_server 工具与 BOOT_REGISTRATIONS 也走这里）
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(name)) throw new Error('name must be alphanumeric (max 32)')
  if (name in (config.mcpServers ?? {})) throw new Error(`name collides with static server: ${name}`)
  if (name in BUILTIN_SERVERS) throw new Error(`name collides with builtin server: ${name}`)
  if (!/^https?:\/\//.test(url)) throw new Error('url must start with http(s)')
  const probed = await probeRemote(url, opts.headers)
  dynamicServers.delete(name)
  conns.delete(name)
  toolsCache.delete(name)
  dynamicServers.set(name, {
    name,
    type: 'remote',
    url,
    enabled: true,
    transport: probed.transport,
    skill_document: opts.skill_document,
    headers: opts.headers,
  })
  const tools = (await probed.client.listTools()).tools ?? []
  // 探测连接直接入池复用：此前用完即弃（不 close 也不入池），每次注册泄漏一条连接
  conns.set(name, { client: probed.client, connectedAt: Date.now() })
  saveSnapshot()
  return { name, transport: probed.transport, tools: tools.map(t => ({ server: name, name: t.name, description: t.description ?? '', input_schema: t.inputSchema })) }
}

/** 动态注销：连、清缓存、移除内联定义。 */
async function unregisterServer(name: string): Promise<void> {
  if (!dynamicServers.has(name)) throw new Error(`not a dynamic server: ${name}`)
  const conn = conns.get(name)
  if (conn) await conn.client.close().catch(() => undefined)
  conns.delete(name)
  toolsCache.delete(name)
  dynamicServers.delete(name)
  lastError.delete(name)
  saveSnapshot()
}

// ── registry 内置工具（AI 自助注册的主要通道；纯文本 PII 勿写 skill_document）──
installBuiltin('registry', {
  tools: [
    {
      name: 'list_servers',
      description: 'List all MCP servers known to the gateway (static + dynamic), with type/enabled/last_error',
      input_schema: {
        type: 'object',
        properties: { include_health: { type: 'boolean', description: 'Try a 5s listTools ping to confirm liveness (default false)' } },
      },
    },
    {
      name: 'register_server',
      description: 'Register a remote MCP server by URL (tensed URL 必须给出); detects Streamable HTTP vs SSE automatically; optional headers for auth (e.g., Authorization Bearer token)',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Alphanumeric server handle (max 32 chars; this is what /call uses)' },
          url: { type: 'string', description: 'MCP endpoint URL (required; AI 需要外部渠道/用户给出了解才知)' },
          skill_document: { type: 'string', description: 'Optional Markdown usage note for this server' },
          headers: { type: 'object', description: 'Optional HTTP headers (e.g., { Authorization: "Bearer <token>" }) for servers requiring authentication' },
        },
        required: ['name', 'url'],
      },
    },
    {
      name: 'unregister_server',
      description: 'Remove a dynamically registered remote server (static config.requires file edit + gateway restart)',
      input_schema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
    {
      name: 'invoke',
      description: "Escape hatch: call any registered (static+dynamic) server's tool directly through the registry",
      input_schema: {
        type: 'object',
        properties: {
          server: { type: 'string' },
          tool: { type: 'string' },
          args: { type: 'object' },
        },
        required: ['server', 'tool'],
      },
    },
  ],
  call: async (tool, args) => {
    const s = (k: string) => String(args[k] ?? '')
    if (tool === 'list_servers') return JSON.stringify(await allServers(args.include_health === true), null, 2)
    if (tool === 'register_server') return JSON.stringify(await registerServer(s('name'), s('url'), { skill_document: args.skill_document ? String(args.skill_document) : undefined, headers: args.headers as Record<string, string> | undefined }), null, 2)
    if (tool === 'unregister_server') { await unregisterServer(s('name')); return `unregistered: ${s('name')}` }
    if (tool === 'invoke') return await callTool(s('server'), s('tool'), (args.args as Record<string, unknown>) ?? {})
    throw new Error(`unknown registry tool: ${tool}`)
  },
})

/** /health 报告用的合并视图（static + dynamic）；当 includeHealth=true 做一次低延时探活。 */
async function allServers(includeHealth = false): Promise<{ name: string; type: string; enabled: boolean; connected: boolean; tools: number | null; last_error: string | null }[]> {
  const primary = [...Object.keys(config.mcpServers).filter(n => !dynamicServers.has(n)), ...dynamicServers.keys()]
  // 与 allTools 同一去重规则：static 配置里的 builtin 不与 BUILTIN_SERVERS 重复列出
  const names = [...primary, ...Object.keys(BUILTIN_SERVERS).filter(n => !primary.includes(n))]
  const out = []
  for (const name of names) {
    const builtin = isBuiltin(name)
    const cfg = builtin ? undefined : serverConfig(name)
    const enabled = cfg ? cfg.enabled !== false : true
    const connected = builtin ? true : conns.has(name)
    const tools = builtin ? BUILTIN_SERVERS[name].tools.length : (toolsCache.get(name)?.tools.length ?? null)
    let lastE = lastError.get(name) ?? null
    if (includeHealth && !builtin && connected) {
      try {
        await Promise.race([conns.get(name)!.client.listTools(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 2_000))])
        lastE = null
      } catch (e) {
        lastE = e instanceof Error ? e.message : String(e)
      }
    }
    out.push({ name, type: builtin ? 'builtin' : (cfg?.type ?? 'remote'), enabled, connected, tools, last_error: lastE })
  }
  return out
}

// builtin 走独立快路径，避免与 SDK transport 类型纠缠
function isBuiltin(server: string): boolean {
  return server in BUILTIN_SERVERS
}

// ── 工具聚合与调用 ──────────────────────────────────────────────────────────
async function listToolsFor(server: string): Promise<ToolInfo[]> {
  if (isBuiltin(server)) return BUILTIN_SERVERS[server].tools
  const cached = toolsCache.get(server)
  if (cached && Date.now() - cached.at < TOOLS_TTL_MS) return cached.tools
  const conn = await getConnection(server)
  const res = await conn.client.listTools()
  const tools: ToolInfo[] = (res.tools ?? []).map(t => ({
    server,
    name: t.name,
    description: t.description ?? '',
    input_schema: t.inputSchema,
  }))
  toolsCache.set(server, { tools, at: Date.now() })
  return tools
}

/** skill_document 解析（「透传」承诺的收口）：像文件路径且存在 → 读内容；否则按内联文本。 */
function resolveSkillDocument(server: string): string | undefined {
  const cfg = serverConfig(server)
  if (!cfg?.skill_document) return undefined
  const doc = cfg.skill_document
  if (!/\.(md|markdown|txt)$/i.test(doc) && !doc.includes('/')) return doc // 内联文本
  try {
    if (existsSync(doc)) return readFileSync(doc, 'utf8')
  } catch { /* 读不到按不存在处理 */ }
  return undefined
}

/** 每 server 的 skill_document（/tools 以兄弟字段透出，避免逐工具重复大段文本）。 */
async function allSkillDocuments(): Promise<Record<string, string>> {
  const names = [...Object.keys(config.mcpServers), ...dynamicServers.keys()]
  const out: Record<string, string> = {}
  for (const name of names) {
    const doc = resolveSkillDocument(name)
    if (doc) out[name] = doc.slice(0, 8000)
  }
  return out
}

async function allTools(): Promise<ToolInfo[]> {
  // server 聚合必须按名去重：static 配置显式声明的 builtin 与 BUILTIN_SERVERS 重叠，
  // 各聚合一次会让同一工具在 /tools 出现两遍（2026-09-01 重复 function 名事故的源头）
  const staticNames = Object.entries(config.mcpServers).filter(([, c]) => c.enabled !== false).map(([n]) => n)
  const dynamicNames = [...dynamicServers.keys()]
  const names = [...staticNames, ...dynamicNames, ...Object.keys(BUILTIN_SERVERS).filter(n => !staticNames.includes(n) && !dynamicNames.includes(n))]
  // 并行聚合：串行 await 会让冷启动 /tools 延迟 = 各 server 之和（远端 server 慢时尤其痛）
  const settled = await Promise.allSettled(names.map(name => listToolsFor(name)))
  const out: ToolInfo[] = []
  for (let i = 0; i < names.length; i++) {
    const name = names[i] ?? ''
    const r = settled[i]
    if (r && r.status === 'fulfilled') {
      out.push(...r.value)
      lastError.delete(name)
    } else if (r) {
      // 单个 server 故障不拖垮聚合（懒连接失败即跳过，下次再试）；故障原因透到 /health
      const reason = r.status === 'rejected' ? r.reason : 'unknown'
      lastError.set(name, reason instanceof Error ? reason.message : String(reason))
      console.error(`[gateway] listTools ${name} failed:`, reason instanceof Error ? reason.message : reason)
    }
  }
  return out
}

async function callTool(server: string, tool: string, args: Record<string, unknown>): Promise<string> {
  const t0 = Date.now()
  let failed = false
  try {
    return await callToolInner(server, tool, args)
  } catch (e) {
    failed = true
    throw e
  } finally {
    recordCallStat(server, tool, Date.now() - t0, failed)
  }
}

async function callToolInner(server: string, tool: string, args: Record<string, unknown>): Promise<string> {
  if (isBuiltin(server)) return await BUILTIN_SERVERS[server].call(tool, args)
  const conn = await getConnection(server)
  // SDK 默认超时之外的显式上限：挂死的远端 server 不该把工具轮拖到 deadline 才被发现
  const res = await Promise.race([
    conn.client.callTool({ name: tool, arguments: args }),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`call timeout after ${CALL_TIMEOUT_MS}ms`)), CALL_TIMEOUT_MS)),
  ])
  if (res.isError) {
    const text = Array.isArray(res.content)
      ? res.content.map((c: { text?: string }) => c.text ?? '').join('\n')
      : JSON.stringify(res)
    throw new Error(`tool error: ${text.slice(0, 500)}`)
  }
  if (Array.isArray(res.content)) {
    return res.content
      .map((c: { type?: string; text?: string }) => (c.type === 'text' ? c.text ?? '' : `[${c.type}]`))
      .join('\n')
      .slice(0, 8000)
  }
  return JSON.stringify(res).slice(0, 8000)
}

// ── HTTP 层（node:http 零依赖）────────────────────────────────────────────
function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

const MAX_BODY_BYTES = 1024 * 1024 // 1MB：工具调用参数的合理天花板，防无鉴权端点被灌内存

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw new Error('payload too large')
  }
  return raw
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      // 每 server 状态透出：Runtime 可以判断某项能力实际是活的还是死的
      return json(res, 200, { ok: true, servers: await allServers(false) })
    }
    if (req.method === 'GET' && url.pathname === '/metrics') {
      return json(res, 200, { ok: true, metrics: renderPromMetrics() })
    }
    // 鉴权面（/health /metrics 只读放行）：配置了共享密钥后，注册/注销/调用/工具列表都要票
    if (!checkAuth(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      return void res.end(JSON.stringify({ error: 'forbidden (x-broker-token required)' }))
    }
    if (req.method === 'POST' && url.pathname === '/register') {
      const body = JSON.parse((await readBody(req)) || '{}') as { name?: string; url?: string; skill_document?: string; headers?: Record<string, string> }
      if (!body.name || !/^[a-zA-Z0-9_-]{1,32}$/.test(body.name)) return json(res, 400, { error: 'name must be alphanumeric (max 32)' })
      if (!body.url || !/^https?:\/\//.test(body.url)) return json(res, 400, { error: 'url must start with http(s)' })
      const meta = await registerServer(body.name, body.url, { skill_document: body.skill_document, headers: body.headers })
      return json(res, 200, { ok: true, name: meta.name, transport: meta.transport, tools: meta.tools.map(t => t.name) })
    }
    if (req.method === 'POST' && url.pathname === '/unregister') {
      const body = JSON.parse((await readBody(req)) || '{}') as { name?: string }
      if (!body.name) return json(res, 400, { error: 'name required' })
      await unregisterServer(body.name)
      return json(res, 200, { ok: true })
    }
    if (req.method === 'GET' && url.pathname === '/tools') {
      return json(res, 200, { tools: await allTools(), skill_documents: await allSkillDocuments() })
    }
    if (req.method === 'POST' && url.pathname === '/call') {
      const body = JSON.parse((await readBody(req)) || '{}') as { server?: string; tool?: string; args?: Record<string, unknown> }
      if (!body.server || !body.tool) return json(res, 400, { error: 'server and tool required' })
      const content = await callTool(body.server, body.tool, body.args ?? {})
      return json(res, 200, { ok: true, content })
    }
    json(res, 404, { error: 'not found' })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'gateway error'
    json(res, msg === 'payload too large' ? 413 : 502, { error: msg.slice(0, 400) })
  }
}

export function createGatewayServer(): Server {
  return createServer((req, res) => { void handleRequest(req, res) })
}

// ── 环境变量预注册（动态注册的持久化路径）─────────────────────────────────────
/**
 * MCP_BOOT_REGISTRATIONS：JSON 数组 [{ name, url, headers?, skill_document? }]。
 * 动态注册本在内存、重启即清空（2026-09-01 Smithery 121 工具随滚动部署蒸发）；
 * headers 可带 Bearer token，故清单只放 env（不进 config 文件/git）。
 * 单个失败只记日志不拒启——远端抖动不该把网关拖进 CrashLoop。
 */
async function bootRegistrations(): Promise<void> {
  const raw = process.env.MCP_BOOT_REGISTRATIONS
  if (!raw) return
  let list: { name: string; url: string; headers?: Record<string, string>; skill_document?: string }[]
  try {
    list = JSON.parse(raw) as typeof list
  } catch (e) {
    console.error('[gateway] MCP_BOOT_REGISTRATIONS 不是合法 JSON，跳过:', e instanceof Error ? e.message : e)
    return
  }
  for (const item of Array.isArray(list) ? list : []) {
    try {
      const meta = await registerServer(item.name, item.url, { headers: item.headers, skill_document: item.skill_document })
      console.log(`[gateway] boot-registered ${meta.name} (${meta.transport}, ${meta.tools.length} tools)`)
    } catch (e) {
      console.error(`[gateway] boot-register ${item.name} failed:`, e instanceof Error ? e.message : e)
    }
  }
}

// 启动顺序：快照读回（known-unverified）→ env 预注册（运维当前意图，优先级更高）→ 懒握手。
// 仅直跑入口时执行——被测试 import 时不起服务、不碰快照文件、不启动巡检
const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false
if (isMain) {
  const server = createGatewayServer()
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[mcp-gateway] listening on :${PORT}; servers: ${Object.keys(config.mcpServers).join(', ')}` +
      (authToken() ? '' : ' (无 BROKER_INTERNAL_TOKEN——端点鉴权关闭，仅限本地 dev)'))
  })
  // 辅线程巡检：失败连接丢弃（下次 use 懒重建）
  setInterval(() => { checkHealth().catch(() => undefined) }, 30_000).unref()
  // 优雅停机：快照是 write-through 不怕丢，但在途调用与 stdio 子进程要收干净
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[mcp-gateway] ${signal} received, shutting down`)
    server.close()
    for (const [name, conn] of conns) {
      await conn.client.close().catch(() => undefined)
      conns.delete(name)
    }
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  loadSnapshot()
  void bootRegistrations()
}
