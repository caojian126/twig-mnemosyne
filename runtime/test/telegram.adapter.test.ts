/**
 * Telegram 适配层回归：分段发送、429 retry_after 退避、幂等去重、未绑定拒绝、
 * 触达回应闭环（回复触达消息 → twig.intervene(outcome=user_engaged)）。
 * chat 管线 mock 掉；TG API 用假 fetch。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/chat/pipeline.js', () => ({
  handleChatCompletion: vi.fn(async () => ({
    status: 200,
    payload: {
      choices: [{ message: { role: 'assistant', content: '回复' } }],
      mnemosyne: { route_reason: 'default' },
    },
  })),
}))

import { sendTelegram, handleUpdate, type TgDeps } from '../src/telegram/adapter.js'
import { handleChatCompletion } from '../src/chat/pipeline.js'

const CLIENT = {
  id: 'c-1', user_id: 'u-1', client_type: 'telegram', key_hash: 'h', display_name: 'tg',
  webhook_url: null, scopes: ['chat'], is_active: true, metadata: { chat_ids: ['1'] },
}
const USER = { id: 'u-1', eternal_id: 'eternal-1', display_name: '杳晦', preferences: {} }

function makeDeps(overrides?: {
  clients?: unknown[]
  users?: unknown[]
  outreachReply?: string | null
}): TgDeps & { twig: { intervene: ReturnType<typeof vi.fn> }; redis: Record<string, ReturnType<typeof vi.fn>> } {
  const set = vi.fn(async () => 'OK')
  const get = vi.fn(async (key: string) => (key.includes('tg:outreach:') ? (overrides?.outreachReply ?? null) : null))
  const db = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM clients')) return { rows: overrides?.clients ?? [CLIENT] }
      if (sql.includes('FROM users')) return { rows: overrides?.users ?? [USER] }
      return { rows: [] }
    }),
  }
  return {
    db: db as unknown as TgDeps['db'],
    redis: { set, get, del: vi.fn(async () => 1) } as unknown as TgDeps['redis'],
    twig: { intervene: vi.fn(async () => ({})) } as unknown as TgDeps['twig'],
    gateway: {}, builder: {}, ingestion: {}, box: {}, mcp: {},
    botToken: 'TEST_TOKEN',
  } as unknown as TgDeps & { twig: { intervene: ReturnType<typeof vi.fn> }; redis: Record<string, ReturnType<typeof vi.fn>> }
}

/** 假 TG API：默认 sendMessage ok；可注入 429 序列。 */
function fakeFetch(responses?: { status: number; body: Record<string, unknown> }[]): ReturnType<typeof vi.fn> {
  const queue = responses ?? []
  let i = 0
  return vi.fn(async () => {
    const r = queue[i]
    if (r && i < queue.length) { i++ }
    const status = r?.status ?? 200
    const body = r && i <= queue.length && r.status !== 200 ? r.body : { ok: true, result: { message_id: 42 } }
    return { status, ok: status === 200, json: async () => body }
  })
}

beforeEach(() => {
  vi.stubGlobal('fetch', fakeFetch())
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('sendTelegram', () => {
  it('超长文本按段切块发送，返回各段 message_id', async () => {
    const ids = await sendTelegram('T', 1, '啊'.repeat(9000))
    const f = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    expect(f.mock.calls.length).toBe(3) // 9000/3800 → 3 段
    expect(ids).toEqual([42, 42, 42])
  })

  it('429 flood control：按 retry_after 退避重试一次', async () => {
    vi.stubGlobal('fetch', fakeFetch([
      { status: 429, body: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 1 } } },
    ]))
    const ids = await sendTelegram('T', 1, 'hello')
    expect(ids).toEqual([42])
    const f = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    expect(f.mock.calls.length).toBe(2)
  }, 10_000)
})

describe('handleUpdate（收信→管线）', () => {
  it('幂等去重：redis NX 抢占失败 → 不进管线', async () => {
    const deps = makeDeps()
    ;(deps.redis.set as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    await handleUpdate(deps, {
      update_id: 1,
      message: { text: '你好', chat: { id: 1, type: 'private' }, from: { id: 9, is_bot: false } },
    })
    expect(handleChatCompletion).not.toHaveBeenCalled()
  })

  it('未绑定 chat：不回复陌生私聊', async () => {
    const deps = makeDeps({ clients: [] })
    await handleUpdate(deps, {
      update_id: 2,
      message: { text: '你好', chat: { id: 99, type: 'private' }, from: { id: 9, is_bot: false } },
    })
    expect(handleChatCompletion).not.toHaveBeenCalled()
  })

  it('bot 回声与群聊一律忽略', async () => {
    const deps = makeDeps()
    await handleUpdate(deps, { update_id: 3, message: { text: 'echo', chat: { id: 1, type: 'private' }, from: { id: 9, is_bot: true } } })
    await handleUpdate(deps, { update_id: 4, message: { text: 'group', chat: { id: 1, type: 'group' }, from: { id: 9, is_bot: false } } })
    expect(handleChatCompletion).not.toHaveBeenCalled()
  })

  it('触达回应闭环：回复触达消息 → twig.intervene(outcome=user_engaged)（§19.6）', async () => {
    const deps = makeDeps({ outreachReply: JSON.stringify({ claimId: 'claim-1', content: '触达文案' }) })
    await handleUpdate(deps, {
      update_id: 5,
      message: {
        text: '看到啦，我确实想说这件事',
        chat: { id: 1, type: 'private' },
        from: { id: 9, is_bot: false },
        reply_to_message: { message_id: 555 },
      },
    })
    expect(handleChatCompletion).toHaveBeenCalled() // 回复文本照常走对话
    await vi.waitFor(() => {
      expect(deps.twig.intervene).toHaveBeenCalledWith('u-1', 'claim-1', '触达文案', { outcome: 'user_engaged' })
    })
  })

  it('普通消息（无 reply_to / 无映射）不触发 engage 上报', async () => {
    const deps = makeDeps()
    await handleUpdate(deps, {
      update_id: 6,
      message: { text: '随便聊聊', chat: { id: 1, type: 'private' }, from: { id: 9, is_bot: false } },
    })
    await new Promise(r => setTimeout(r, 10))
    expect(deps.twig.intervene).not.toHaveBeenCalled()
  })
})
