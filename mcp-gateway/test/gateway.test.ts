/**
 * MCP Gateway HTTP 层回归（此前零测试；两次历史事故——重复聚合、快照蒸发——都在这一层）：
 * 内置 core 工具 E2E、鉴权开关（BROKER_INTERNAL_TOKEN 配置即全端点要票）、
 * 注册校验（名称/URL/撞名）、未知 server 调用 fail-loud、调用指标落账。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Server } from 'node:http'
import { createGatewayServer } from '../src/index.js'

let server: Server
let baseUrl = ''

beforeAll(async () => {
  delete process.env.BROKER_INTERNAL_TOKEN // 默认开放态
  server = createGatewayServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as { port: number }
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  delete process.env.BROKER_INTERNAL_TOKEN
  await new Promise<void>(resolve => server.close(() => resolve()))
})

const json = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body != null ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

describe('gateway HTTP 层', () => {
  it('GET /health：内置 core 在册且 connected', async () => {
    const { status, data } = await json('GET', '/health')
    expect(status).toBe(200)
    const servers = data.servers as { name: string; connected: boolean; type: string }[]
    const core = servers.find(s => s.name === 'core')
    expect(core?.connected).toBe(true)
    expect(core?.type).toBe('builtin')
  })

  it('GET /tools：core 工具聚合一次（get_current_time 在列），skill_documents 为对象', async () => {
    const { status, data } = await json('GET', '/tools')
    expect(status).toBe(200)
    const tools = data.tools as { server: string; name: string }[]
    const coreTools = tools.filter(t => t.server === 'core')
    expect(coreTools.length).toBeGreaterThan(0)
    // 去重铁律：同一 function 名不得出现两次（2026-09-01 事故）
    const names = tools.map(t => `${t.server}/${t.name}`)
    expect(new Set(names).size).toBe(names.length)
    expect(data.skill_documents).toBeTypeOf('object')
  })

  it('POST /call：内置 core 的 get_current_time E2E 可用', async () => {
    const { status, data } = await json('POST', '/call', { server: 'core', tool: 'get_current_time', args: {} })
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    expect(String(data.content)).toContain('T') // ISO 时间
  })

  it('POST /call：未知 server fail-loud（不静默返回空）', async () => {
    const { status, data } = await json('POST', '/call', { server: 'nope', tool: 'x', args: {} })
    expect(status).toBe(502)
    expect(String(data.error)).toContain('nope')
  })

  it('POST /register：名称/URL 校验拒绝；撞 builtin 名拒绝', async () => {
    const badName = await json('POST', '/register', { name: 'has space', url: 'https://example.com/mcp' })
    expect(badName.status).toBe(400)
    const badUrl = await json('POST', '/register', { name: 'ok-name', url: 'ftp://example.com' })
    expect(badUrl.status).toBe(400)
    const collide = await json('POST', '/register', { name: 'core', url: 'https://example.com/mcp' })
    expect(collide.status).toBe(502)
    expect(String(collide.data.error)).toContain('collides')
  })

  it('鉴权开关：BROKER_INTERNAL_TOKEN 配置后 /register /call /tools 全要票', async () => {
    process.env.BROKER_INTERNAL_TOKEN = 'test-secret-token'
    try {
      const noTokenTools = await json('GET', '/tools')
      expect(noTokenTools.status).toBe(403)
      const noTokenCall = await json('POST', '/call', { server: 'core', tool: 'get_current_time', args: {} })
      expect(noTokenCall.status).toBe(403)
      const noTokenRegister = await json('POST', '/register', { name: 'x', url: 'https://example.com/mcp' })
      expect(noTokenRegister.status).toBe(403)
      // 带票放行（health 与 metrics 只读面保持开放）
      const authed = await json('GET', '/tools', undefined, { 'x-broker-token': 'test-secret-token' })
      expect(authed.status).toBe(200)
    } finally {
      delete process.env.BROKER_INTERNAL_TOKEN
    }
  })

  it('调用指标：失败的 /call 落 error 计数，/metrics 可读', async () => {
    await json('POST', '/call', { server: 'nope-metrics', tool: 'f', args: {} })
    const res = await fetch(`${baseUrl}/metrics`)
    const { metrics } = (await res.json()) as { metrics: string }
    expect(metrics).toContain('mcp_gateway_tool_errors_total{server="nope-metrics",tool="f"} 1')
  })
})
