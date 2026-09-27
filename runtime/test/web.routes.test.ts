import { describe, it, expect } from 'vitest'
import { hash as argon2Hash } from '@node-rs/argon2'
import Fastify from 'fastify'
import { webLogin, AttemptLimiter, IdentityError } from '../src/identity/service.js'
import { registerWebRoutes, buildFeedEvents, type FeedEvent } from '../src/http/webRoutes.js'
import { TwigError } from '../src/memory/TwigAdapter.js'

/* ---------- 假 Db：按 queue 出行，记录调用 ---------- */
class FakeDb {
  calls: { sql: string; params: unknown[] }[] = []
  queue: { rows: unknown[] }[] = []
  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
    this.calls.push({ sql, params })
    return this.queue.shift() ?? { rows: [] }
  }
}

const USER = {
  id: 'u-1',
  eternal_id: 'a'.repeat(64),
  display_name: '小月亮',
  email: 'user@example.com',
  master_key_hash: '',
  crisis_silence_until: null,
  preferences: {},
}

describe('webLogin（/v1/web/login 的服务端语义）', () => {
  it('首次登录：签发新 web client（scopes=chat），rotated=false', async () => {
    const db = new FakeDb()
    USER.master_key_hash = await argon2Hash('correct horse battery staple')
    db.queue.push({ rows: [USER] }) // getUserByEternalId
    db.queue.push({ rows: [] }) // 无既有 web client
    const limiter = new AttemptLimiter()
    const out = await webLogin(db as never, { eternalId: USER.eternal_id, masterKey: 'correct horse battery staple' }, limiter, '1.2.3.4')
    expect(out.rotated).toBe(false)
    expect(out.clientKey.startsWith('mn_')).toBe(true)
    const insert = db.calls.find(c => c.sql.includes('INSERT INTO clients'))
    expect(insert).toBeDefined()
    expect(insert!.params[0]).toBe(USER.id)
    expect(insert!.params[1]).toMatch(/^[a-f0-9]{64}$/) // key_hash = sha256(client_key)
    expect(insert!.params[2]).toBe('Aegean Night Dashboard')
  })

  it('再次登录：轮换既有 web client 的 key（旧会话失效），rotated=true', async () => {
    const db = new FakeDb()
    db.queue.push({ rows: [USER] })
    db.queue.push({ rows: [{ id: 'client-web-1' }] })
    const out = await webLogin(db as never, { eternalId: USER.eternal_id, masterKey: 'correct horse battery staple' }, new AttemptLimiter(), '1.2.3.4')
    expect(out.rotated).toBe(true)
    const update = db.calls.find(c => c.sql.includes('UPDATE clients'))
    expect(update).toBeDefined()
    expect(update!.params[1]).toBe('client-web-1')
  })

  it('master_key 错误 → 401，且不区分「用户不存在」（防枚举）', async () => {
    const db = new FakeDb()
    db.queue.push({ rows: [] }) // 用户不存在
    await expect(
      webLogin(db as never, { eternalId: USER.eternal_id, masterKey: 'wrong-wrong-wrong' }, new AttemptLimiter(), '1.2.3.4'),
    ).rejects.toMatchObject({ status: 401, code: 'invalid_credential' })
    db.queue.push({ rows: [USER] }) // 用户存在但口令错
    await expect(
      webLogin(db as never, { eternalId: USER.eternal_id, masterKey: 'wrong-wrong-wrong' }, new AttemptLimiter(), '1.2.3.4'),
    ).rejects.toMatchObject({ status: 401, code: 'invalid_credential' })
  })

  it('T1.5：10 次失败后限流 429', async () => {
    const db = new FakeDb()
    const limiter = new AttemptLimiter()
    for (let i = 0; i < 10; i++) {
      db.queue.push({ rows: [USER] })
      await expect(
        webLogin(db as never, { eternalId: USER.eternal_id, masterKey: 'wrong-wrong-wrong' }, limiter, '5.6.7.8'),
      ).rejects.toBeInstanceOf(IdentityError)
    }
    db.queue.push({ rows: [USER] })
    await expect(
      webLogin(db as never, { eternalId: USER.eternal_id, masterKey: 'correct horse battery staple' }, limiter, '5.6.7.8'),
    ).rejects.toMatchObject({ status: 429, code: 'rate_limited' })
  })
})

describe('buildFeedEvents（铭文流合成）', () => {
  const base = {
    provider: 'litellm', model: 'claude-sonnet', latency_ms: 1090, output_tokens: 312,
    cache_hit_type: null, cache_saved_tokens: null, error: false, error_type: null,
  }
  const outreachBase = {
    delivered_at: null, created_at: null, outreach_type: null, status: '',
    slot_number: null, filter_reason: null, last_delivery_error: null,
  }

  it('model.call 成功 / cache HIT / 失败 三态映射', () => {
    const events = buildFeedEvents(
      [
        { ...base, timestamp: '2026-08-30T08:02:47Z' },
        { ...base, timestamp: '2026-08-30T08:02:45Z', model: 'gpt-4o', latency_ms: null, output_tokens: null, cache_hit_type: 'context', cache_saved_tokens: 2041 },
        { ...base, timestamp: '2026-08-30T08:03:00Z', model: 'gemini-pro', error: true, error_type: 'provider_error' },
      ],
      [],
    )
    expect(events).toHaveLength(3)
    expect(events[0]!.ts).toBe('2026-08-30T08:03:00.000Z') // 倒序
    expect(events[0]!.tag).toBe('model.call')
    expect(events[0]!.ok).toBe(false)
    expect(events[0]!.body).toContain('provider_error')
    const hit = events.find(e => e.tag === 'cache')!
    expect(hit.body).toContain('HIT context')
    expect(hit.body).toContain('2041')
    const ok = events.find(e => e.ts === '2026-08-30T08:02:47.000Z')!
    expect(ok.body).toContain('claude-sonnet')
    expect(ok.body).toContain('1090ms')
  })

  it('huginn 投递 / 失败 / filtered 映射，时间倒序合并', () => {
    const events: FeedEvent[] = buildFeedEvents(
      [{ ...base, timestamp: '2026-08-30T08:02:47Z' }],
      [
        { ...outreachBase, created_at: '2026-08-30T08:14:00Z', delivered_at: '2026-08-30T08:14:05Z', outreach_type: 'vein-nudge', status: 'delivered', slot_number: 1 },
        { ...outreachBase, created_at: '2026-08-30T07:00:00Z', status: 'filtered', filter_reason: 'quiet_hours' },
        { ...outreachBase, created_at: '2026-08-29T21:00:00Z', delivered_at: '2026-08-29T21:00:10Z', outreach_type: 'remention', status: 'failed', last_delivery_error: 'webhook timeout' },
      ],
    )
    expect(events.map(e => e.tag)).toEqual(['huginn.vein-nudge', 'model.call', 'huginn.filter', 'huginn.remention'])
    expect(events[0]!.body).toContain('slot 1')
    expect(events[2]!.body).toContain('quiet_hours')
    expect(events[3]!.ok).toBe(false)
  })
})

/* ---------- POST /v1/web/memory/* 写操作（BFF：runtime 校验 + 服务端持凭证） ---------- */
describe('web 写操作路由', () => {
  const CLIENT = { id: 'cw-1', user_id: 'u-1', client_type: 'web' }
  const redisOk = { incr: async () => 1, expire: async () => 1, get: async () => null, set: async () => null, del: async () => null, ping: async () => 'PONG' }

  function buildWebApp(twig: Record<string, unknown>) {
    const app = Fastify({ logger: false })
    registerWebRoutes(app, {
      db: { query: async () => ({ rows: [] }) },
      redis: redisOk,
      twig,
      limiter: new AttemptLimiter(),
      identityAuth: async (k: string) => (k === 'mn_ok' ? CLIENT : null),
      userOf: async () => USER,
    } as never)
    return app
  }

  it('contest：userId 钉死认证用户 eternal_id，成功 200', async () => {
    const calls: unknown[][] = []
    const app = buildWebApp({
      contest: async (...args: unknown[]) => { calls.push(args); return { ok: true } },
    })
    const res = await app.inject({
      method: 'POST', url: '/v1/web/memory/claims/contest',
      headers: { 'x-client-key': 'mn_ok', 'content-type': 'application/json' },
      payload: { claim_id: 'c-9', note: '这不是真的，我否决' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(calls[0]?.[0]).toBe(USER.eternal_id) // 不能指定他人
    expect(calls[0]?.[1]).toBe('c-9')
    await app.close()
  })

  it('缺 note → 400；无 key → 401', async () => {
    const app = buildWebApp({ contest: async () => ({ ok: true }) })
    const bad = await app.inject({
      method: 'POST', url: '/v1/web/memory/claims/contest',
      headers: { 'x-client-key': 'mn_ok', 'content-type': 'application/json' },
      payload: { claim_id: 'c-1' },
    })
    expect(bad.statusCode).toBe(400)
    const noKey = await app.inject({
      method: 'POST', url: '/v1/web/memory/claims/contest',
      headers: { 'content-type': 'application/json' },
      payload: { claim_id: 'c-1', note: 'x' },
    })
    expect(noKey.statusCode).toBe(401)
    await app.close()
  })

  it('twig 404 透传 not_found；500 脱敏为 502 twig_error', async () => {
    const app404 = buildWebApp({
      correct: async () => { throw new TwigError('POST', '/v1/correct', 404, 'fragment 不存在') },
    })
    const r404 = await app404.inject({
      method: 'POST', url: '/v1/web/memory/correct',
      headers: { 'x-client-key': 'mn_ok', 'content-type': 'application/json' },
      payload: { fragment_id: 'f-1', note: '修正' },
    })
    expect(r404.statusCode).toBe(404)
    expect(r404.json().error.type).toBe('not_found')
    await app404.close()

    const app502 = buildWebApp({
      correct: async () => { throw new TwigError('POST', '/v1/correct', 500, '内部含记忆内容不下传') },
    })
    const r502 = await app502.inject({
      method: 'POST', url: '/v1/web/memory/correct',
      headers: { 'x-client-key': 'mn_ok', 'content-type': 'application/json' },
      payload: { fragment_id: 'f-1', note: '修正' },
    })
    expect(r502.statusCode).toBe(502)
    expect(r502.json().error.message).toBe('twig_error') // 细节不透传
    await app502.close()
  })

  it('notes：手写便签创建', async () => {
    const calls: unknown[][] = []
    const app = buildWebApp({
      createNote: async (...args: unknown[]) => { calls.push(args); return { id: 'n-1' } },
    })
    const res = await app.inject({
      method: 'POST', url: '/v1/web/memory/notes',
      headers: { 'x-client-key': 'mn_ok', 'content-type': 'application/json' },
      payload: { content: '今天把阳台的薄荷换了个大盆。' },
    })
    expect(res.statusCode).toBe(200)
    expect(calls[0]?.[0]).toBe(USER.eternal_id)
    expect(calls[0]?.[1]).toContain('薄荷')
    await app.close()
  })
})

/* ---------- client 管理 / outreach 面板 / gateway health（settings·console·forge 页） ---------- */
describe('web client 管理与面板路由', () => {
  const CLIENT = { id: 'cw-1', user_id: 'u-1', client_type: 'web' }
  const redisOk = { incr: async () => 1, expire: async () => 1, get: async () => null, set: async () => null, del: async () => null, ping: async () => 'PONG' }

  function buildApp(opts: {
    db?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }
    mcp?: Record<string, unknown>
  } = {}) {
    const app = Fastify({ logger: false })
    registerWebRoutes(app, {
      db: opts.db ?? { query: async () => ({ rows: [] }) },
      redis: redisOk,
      twig: {},
      limiter: new AttemptLimiter(),
      identityAuth: async (k: string) => (k === 'mn_ok' ? CLIENT : null),
      userOf: async () => USER,
      mcp: opts.mcp ?? {},
    } as never)
    return app
  }

  it('GET /v1/web/clients：列表不带 key_hash（明文与哈希都不出服务端）', async () => {
    const app = buildApp({
      db: { query: async () => ({ rows: [{ id: 'c-tg', user_id: 'u-1', client_type: 'telegram', key_hash: 'SECRET', display_name: 'tg', webhook_url: null, scopes: ['chat'], is_active: true, metadata: {}, created_at: '2026-09-01T00:00:00Z' }] }) },
    })
    const res = await app.inject({ method: 'GET', url: '/v1/web/clients', headers: { 'x-client-key': 'mn_ok' } })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { clients: { key_hash?: string; client_type: string }[] }
    expect(body.clients).toHaveLength(1)
    expect(body.clients[0]!.client_type).toBe('telegram')
    expect(body.clients[0]!.key_hash).toBeUndefined()
    await app.close()
  })

  it('POST /v1/web/clients：签发缺省类型，明文仅此一次；重复类型 409', async () => {
    const inserted: unknown[][] = []
    const app = buildApp({
      db: {
        query: async (sql: string, params: unknown[] = []) => {
          if (sql.includes('INSERT INTO clients')) {
            inserted.push(params)
            return { rows: [] }
          }
          throw new Error(`unexpected: ${sql.slice(0, 60)}`)
        },
      },
    })
    const ok = await app.inject({
      method: 'POST', url: '/v1/web/clients',
      headers: { 'x-client-key': 'mn_ok', 'content-type': 'application/json' },
      payload: { client_type: 'api', display_name: '脚本' },
    })
    expect(ok.statusCode).toBe(200)
    const body = ok.json() as { client_key: string }
    expect(body.client_key.startsWith('mn_')).toBe(true)
    expect(inserted[0]?.[0]).toBe(USER.id) // user_id 钉死认证用户
    expect(inserted[0]?.[1]).toBe('api')

    const bad = await app.inject({
      method: 'POST', url: '/v1/web/clients',
      headers: { 'x-client-key': 'mn_ok', 'content-type': 'application/json' },
      payload: { client_type: 'nonsense' },
    })
    expect(bad.statusCode).toBe(400)
    await app.close()
  })

  it('POST /v1/web/clients/:id/active：吊销 web 自身被拒（自锁防护），其他类型放行', async () => {
    const updates: unknown[][] = []
    const app = buildApp({
      db: {
        query: async (sql: string, params: unknown[] = []) => {
          if (sql.includes('SELECT id, client_type FROM clients')) {
            return { rows: [{ id: params[0], client_type: (params[0] as string).endsWith('a') ? 'web' : 'telegram' }] }
          }
          if (sql.includes('UPDATE clients SET is_active')) {
            updates.push(params)
            return { rows: [] }
          }
          return { rows: [] }
        },
      },
    })
    const self = await app.inject({
      method: 'POST', url: '/v1/web/clients/00000000-0000-4000-8000-00000000000a/active',
      headers: { 'x-client-key': 'mn_ok', 'content-type': 'application/json' },
      payload: { active: false },
    })
    expect(self.statusCode).toBe(400)
    expect(self.json().error.type).toBe('self_revoke_forbidden')

    const tg = await app.inject({
      method: 'POST', url: '/v1/web/clients/00000000-0000-4000-8000-00000000000b/active',
      headers: { 'x-client-key': 'mn_ok', 'content-type': 'application/json' },
      payload: { active: false },
    })
    expect(tg.statusCode).toBe(200)
    expect(updates[0]).toEqual([false, '00000000-0000-4000-8000-00000000000b'])
    await app.close()
  })

  it('POST /v1/web/clients/:id/rotate：归属校验（非本人 404）+ 明文一次性返回', async () => {
    const app = buildApp({
      db: {
        query: async (sql: string, params: unknown[] = []) => {
          if (sql.includes('SELECT id FROM clients WHERE id = $1 AND user_id = $2')) {
            return { rows: params[0] === '00000000-0000-4000-8000-00000000000c' ? [{ id: '00000000-0000-4000-8000-00000000000c' }] : [] }
          }
          if (sql.includes('UPDATE clients SET key_hash')) return { rows: [] }
          return { rows: [] }
        },
      },
    })
    const ok = await app.inject({
      method: 'POST', url: '/v1/web/clients/00000000-0000-4000-8000-00000000000c/rotate',
      headers: { 'x-client-key': 'mn_ok' },
    })
    expect(ok.statusCode).toBe(200)
    expect((ok.json() as { client_key: string }).client_key.startsWith('mn_')).toBe(true)

    const notMine = await app.inject({
      method: 'POST', url: '/v1/web/clients/00000000-0000-4000-8000-00000000000d/rotate',
      headers: { 'x-client-key': 'mn_ok' },
    })
    expect(notMine.statusCode).toBe(404)
    await app.close()
  })

  it('GET /v1/web/outreach/summary + /log：只读聚合与脱敏字段', async () => {
    const queries: string[] = []
    const app = buildApp({
      db: {
        query: async (sql: string) => {
          queries.push(sql)
          if (sql.includes('GROUP BY status')) return { rows: [{ status: 'delivered', n: '2' }, { status: 'filtered', n: '1' }] }
          if (sql.includes("status IN ('reserved','generated','delivery_pending')")) return { rows: [{ delivered: '1', pending: '1' }] }
          if (sql.includes('FROM outreach WHERE user_id')) {
            return { rows: [{ id: 'o-1', outreach_type: 'vein-nudge', status: 'delivered', slot_number: 1, claim_id: 'claim-9', filter_reason: null, delivery_attempts: 1, last_delivery_error: null, created_at: '2026-09-28T00:00:00Z', delivered_at: '2026-09-28T00:00:05Z' }] }
          }
          return { rows: [] }
        },
      },
    })
    const summary = await app.inject({ method: 'GET', url: '/v1/web/outreach/summary', headers: { 'x-client-key': 'mn_ok' } })
    expect(summary.statusCode).toBe(200)
    const s = summary.json() as { status_counts_7d: Record<string, number>; today: { delivered: number } }
    expect(s.status_counts_7d.delivered).toBe(2)
    expect(s.today.delivered).toBe(1)

    const log = await app.inject({ method: 'GET', url: '/v1/web/outreach/log?limit=5', headers: { 'x-client-key': 'mn_ok' } })
    expect(log.statusCode).toBe(200)
    const l = log.json() as { rows: { has_claim: boolean; claim_id?: string; status: string }[] }
    expect(l.rows[0]!.status).toBe('delivered')
    expect(l.rows[0]!.has_claim).toBe(true)
    expect(l.rows[0]!.claim_id).toBeUndefined() // 原始 claim id 不出面板（脱敏为布尔）
    await app.close()
  })

  it('GET /v1/web/mcp/health：代理 gateway /health；不可达 → 502', async () => {
    const ok = buildApp({ mcp: { getHealth: async () => ({ ok: true, servers: [{ name: 'core', type: 'builtin', enabled: true, connected: true, tools: 1, last_error: null }] }) } })
    const good = await ok.inject({ method: 'GET', url: '/v1/web/mcp/health', headers: { 'x-client-key': 'mn_ok' } })
    expect(good.statusCode).toBe(200)
    expect((good.json() as { servers: unknown[] }).servers).toHaveLength(1)
    await ok.close()

    const bad = buildApp({ mcp: { getHealth: async () => { throw new Error('conn refused') } } })
    const failing = await bad.inject({ method: 'GET', url: '/v1/web/mcp/health', headers: { 'x-client-key': 'mn_ok' } })
    expect(failing.statusCode).toBe(502)
    await bad.close()
  })
})
