/**
 * chat 管线核心回归（0903 审查修复集中地，此前无直接测试）：
 * 链式 fallback（可重试错误 → 下一候选、用量与缓存键按 usedModel 配对）、
 * 危机路径（链/温度/route_reason/独立审计）、隐私 local 泳道（fail-closed 工具剥离）、
 * 失败路径 usage 落行（error=true——errors_total 此前恒 0 的盲区）。依赖全用假件。
 */
import { describe, it, expect, vi } from 'vitest'
import { handleChatCompletion, type ChatDeps } from '../src/chat/pipeline.js'
import { LiteLlmError, type ChatResult } from '../src/gateways/litellm.js'
import { IdentityError } from '../src/identity/service.js'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { TwigAdapter } from '../src/memory/TwigAdapter.js'
import type { ContextBuilder } from '../src/context/builder.js'
import type { MemoryIngestionPipeline } from '../src/memory/ingestion.js'
import type { Box } from '../src/util/crypto.js'
import type { McpGatewayClient } from '../src/tools/executor.js'

const USER = { id: 'u-1', eternal_id: 'eternal-1', display_name: '杳晦', email: 'u@example.com', master_key_hash: 'h', crisis_silence_until: null, preferences: {} }
const CLIENT = { id: 'c-1', user_id: 'u-1', client_type: 'rikkahub', key_hash: 'h', display_name: 'rikka', webhook_url: null, scopes: ['chat'], is_active: true, metadata: {} }

function chatResult(model: string, content: string): ChatResult {
  return { id: `chatcmpl-${model}`, model, content, promptTokens: 100, completionTokens: 20, cachedTokens: 0, latencyMs: 5 }
}

function makeDb() {
  const calls: { sql: string; params?: unknown[] }[] = []
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params })
    if (sql.includes('INSERT INTO sessions')) {
      return { rows: [{ id: 's-1', context_window: 32000, session_type: 'personal', eternal_session_id: 'sess_x' }] }
    }
    if (sql.includes('INSERT INTO conversation_messages')) return { rows: [{ id: 'm-1' }] }
    return { rows: [] }
  })
  return { calls, query }
}

function makeDeps(opts: { chainBehavior: (model: string) => ChatResult | never }) {
  const db = makeDb()
  const chat = vi.fn(async (model: string, _msgs: unknown, callOpts?: { maxTokens?: number; temperature?: number }) => {
    // 泳道分类调用（deepseek-flash, maxTokens 8）先于链循环
    if (callOpts?.maxTokens === 8) return chatResult(model, 'chat')
    const r = opts.chainBehavior(model)
    return r
  })
  const deps = {
    db: { query: db.query } as unknown as Pool,
    redis: { get: vi.fn(async () => null), set: vi.fn(async () => 'OK'), del: vi.fn(async () => 1) } as unknown as Redis,
    twig: { getContextPacket: vi.fn(async () => ({ promptText: '叙事包', threads: [], claims: [], recentFragments: [] })) } as unknown as TwigAdapter,
    gateway: { chat } as unknown as ChatDeps['gateway'],
    builder: {
      build: vi.fn(async () => ({
        messages: [{ role: 'system', content: 'sys' }],
        narrativeVersion: 'nv-1',
        packet: { promptText: '叙事包', threads: [], claims: [], recentFragments: [] },
        budget: { persona: 0, voicePersona: 0, crisis: 0, promptText: 0, capabilities: 0, toolState: 0, currentMessage: 0, outputReserve: 0, safetyBuffer: 0, recent: 0 },
        narrativeUnavailable: false,
      })),
    } as unknown as ContextBuilder,
    ingestion: { ingestTurn: vi.fn(async () => ({})) } as unknown as MemoryIngestionPipeline,
    box: { encrypt: vi.fn((s: string) => `enc(${s.length})`) } as unknown as Box,
    mcp: { listTools: vi.fn(async () => ({ tools: [], skillDocuments: {} })) } as unknown as McpGatewayClient,
  } as unknown as ChatDeps & { db: ReturnType<typeof makeDb> }
  // 让断言能摸到 db 记录
  ;(deps as unknown as { __db: typeof db }).__db = db
  return deps as unknown as ChatDeps & { __db: ReturnType<typeof makeDb> }
}

function usageRow(deps: ChatDeps & { __db: ReturnType<typeof makeDb> }): { params: unknown[] } {
  const row = deps.__db.calls.find(c => c.sql.includes('INSERT INTO usage_logs'))
  expect(row).toBeDefined()
  return { params: row!.params ?? [] }
}

describe('chat 管线核心（§14.2 主管线回归）', () => {
  it('链式 fallback：首候选可重试失败 → 下一候选接棒，用量行按 usedModel 记 fallback_count', async () => {
    const deps = makeDeps({
      chainBehavior(model) {
        if (model === 'kimi-k2.6') throw new LiteLlmError(500, 'upstream boom')
        return chatResult(model, '月亮升起来了。')
      },
    })
    const outcome = await handleChatCompletion(deps, {
      client: CLIENT, user: USER, messages: [{ role: 'user', content: '讲个开头' }],
    })
    expect(outcome.status).toBe(200)
    expect(outcome.payload.model).toBe('gpt-4o')
    const mn = outcome.payload.mnemosyne as { fallback_count?: number; route_reason?: string }
    expect(mn.fallback_count).toBe(1)
    expect(mn.route_reason).toBe('default')
    // 用量行：成功路径 error=false、模型=gpt-4o、成本已按价格表估算（gpt-4o 有价）
    const row = usageRow(deps)
    expect(row.params[5]).toBe('gpt-4o')
    expect(row.params[16]).toBe(1) // fallback_count
    expect(row.params[17]).toBe(false)
    expect(typeof row.params[13]).toBe('number') // cost_usd
  })

  it('危机路径：跳过泳道分类、走云端链、温度锁 1、独立加密审计落 crisis_audit', async () => {
    const deps = makeDeps({ chainBehavior: model => chatResult(model, '我在，说说看。') })
    const outcome = await handleChatCompletion(deps, {
      client: CLIENT, user: USER, messages: [{ role: 'user', content: '我不想活了' }],
    })
    expect(outcome.status).toBe(200)
    const mn = outcome.payload.mnemosyne as { route_reason?: string }
    expect(mn.route_reason).toBe('crisis_path')
    // 链首选 kimi-k2.6（temperatureLock → 1）
    expect(outcome.payload.model).toBe('kimi-k2.6')
    const chat = (deps.gateway as unknown as { chat: ReturnType<typeof vi.fn> }).chat
    const chainCall = chat.mock.calls.find((c: unknown[]) => c[0] === 'kimi-k2.6' && (c[2] as { maxTokens?: number }).maxTokens !== 8)
    expect((chainCall?.[2] as { temperature?: number }).temperature).toBe(1)
    // 危机独立审计（append-only 加密）
    const audit = deps.__db.calls.find(c => c.sql.includes('INSERT INTO crisis_audit'))
    expect(audit).toBeDefined()
    expect((deps.box as unknown as { encrypt: ReturnType<typeof vi.fn> }).encrypt).toHaveBeenCalled()
    // 危机轮不查缓存命中写入面：twig 包获取被跳过（§3.9 预扫管线决策）
    expect((deps.twig as unknown as { getContextPacket: ReturnType<typeof vi.fn> }).getContextPacket).not.toHaveBeenCalled()
  })

  it('全链失败：抛 all_providers_down（502），且失败路径落 error=true 的用量行（可观测收口）', async () => {
    const deps = makeDeps({
      chainBehavior(model) {
        if (model === 'deepseek-flash') return chatResult(model, 'chat')
        throw new LiteLlmError(500, `down: ${model}`)
      },
    })
    await expect(handleChatCompletion(deps, {
      client: CLIENT, user: USER, messages: [{ role: 'user', content: '随便聊聊' }],
    })).rejects.toMatchObject({ code: 'all_providers_down', status: 502 } satisfies Partial<IdentityError>)
    const row = usageRow(deps)
    expect(row.params[17]).toBe(true) // error
    expect(row.params[18]).toBe('all_providers_down') // error_type
  })

  it('隐私 local 泳道：显式 privacy=high 锁本地链、不拉网关工具（§20 fail-closed）', async () => {
    const deps = makeDeps({ chainBehavior: model => chatResult(model, '好的。') })
    const outcome = await handleChatCompletion(deps, {
      client: CLIENT, user: USER,
      metadata: { privacy: 'high' },
      messages: [{ role: 'user', content: '帮我记住这个地址' }],
    })
    const mn = outcome.payload.mnemosyne as { route_reason?: string }
    expect(mn.route_reason).toBe('privacy_tier:local')
    expect(outcome.payload.model).toBe('ollama/qwen3:8b')
    expect((deps.mcp as unknown as { listTools: ReturnType<typeof vi.fn> }).listTools).not.toHaveBeenCalled()
  })
})
