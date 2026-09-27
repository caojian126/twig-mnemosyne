#!/usr/bin/env node
/**
 * backup-local.mjs — Zeabur 部署的本地拉取备份（§13.6 的 Zeabur 路线，备份目的地=本机）。
 *
 * 覆盖物（与 VPS 版 backup.sh 同口径，dump 格式为 custom）：
 *   1. Postgres 逻辑备份（pg_dump custom 格式）——需 Zeabur postgres 开公网 + 本机装 pg 客户端；
 *   2. twig 叙事数据（叙事+情感层）：经 mnemosyne 公网域名 /v1/web/* 拉全量 JSON 快照
 *      （journal/soliloquy 全量导出 + claims/context/audit + state/notes/stamps 分页拉尽）。
 *   Redis 不备（缓存可再生，§13.6）。
 *
 * 2026-09-28 加固：
 *   - 时间戳到秒（同日重跑不再覆盖好备份）+ .tmp 原子改名；
 *   - 每轮生成 SHA256SUMS 清单 + pg_restore --list 冒烟（「备份未验证等于没有备份」）；
 *   - JSON 快照非空断言（此前 client_key 失效曾把字面 null 写进文件还打 ✓）；
 *   - 失败可选 Telegram 通知（NOTIFY_TG_BOT_TOKEN + NOTIFY_TG_CHAT_ID）；
 *   - fetch 全带超时；BACKUP_ROOT/backup.lock 防并发重入。
 *
 * 配置（优先读 scripts/backup.local.env 的 KEY=VALUE，其次进程 env；该 env 文件不入 git）：
 *   BACKUP_ROOT            备份根目录（默认 <repo>/backups）
 *   PGBACKUP_URL           公网 postgres 连接串 postgresql://mnemosyne:<pass>@<host>:<port>/mnemosyne
 *   PGDUMP_BIN             pg_dump 路径（默认从 PATH 找；Windows 可指 C:\Program Files\PostgreSQL\16\bin\pg_dump.exe）
 *   PGRESTORE_BIN          pg_restore 路径（默认从 PATH 找；缺失时冒烟跳过并告警）
 *   MNEMOSYNE_BASE         mnemosyne 公网域名（如 https://twig-mnemosyne.zeabur.app）
 *   MNEMOSYNE_WEB_KEY      既有 web client_key（mn_…）；给了则跳过登录
 *   MNEMOSYNE_ETERNAL_ID   64 位 hex（登录用，与 MASTER_KEY 二选一组合）
 *   MNEMOSYNE_MASTER_KEY   master_key（登录换 client_key）
 *   RETAIN_DAYS            滚动保留天数（默认 14）
 *   NOTIFY_TG_BOT_TOKEN    失败通知用 bot token（可选；与 mnemosyne 共用 bot 时直接复用 env）
 *   NOTIFY_TG_CHAT_ID      失败通知用 chat id（可选）
 *
 * 用法：node scripts/backup-local.mjs
 * 每日定时（Windows 管理员）：
 *   schtasks /Create /SC DAILY /ST 04:30 /TN MnemosyneBackup ^
 *     /TR "cmd /c cd /d <repo> && node scripts\backup-local.mjs >> backups\backup.log 2>&1"
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

/* ---------- 配置装载 ---------- */
const envFile = join(here, 'backup.local.env')
const cfg = {}
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m && !line.trim().startsWith('#')) cfg[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
const get = (k, dflt) => cfg[k] ?? process.env[k] ?? dflt

const BACKUP_ROOT = resolve(get('BACKUP_ROOT', join(repoRoot, 'backups')))
const PGBACKUP_URL = get('PGBACKUP_URL')
const PGDUMP_BIN = get('PGDUMP_BIN', 'pg_dump')
const PGRESTORE_BIN = get('PGRESTORE_BIN', 'pg_restore')
const BASE = (get('MNEMOSYNE_BASE') ?? '').replace(/\/$/, '')
const WEB_KEY = get('MNEMOSYNE_WEB_KEY')
const ETERNAL_ID = get('MNEMOSYNE_ETERNAL_ID')
const MASTER_KEY = get('MNEMOSYNE_MASTER_KEY')
const RETAIN_DAYS = Number(get('RETAIN_DAYS', '14'))
const NOTIFY_TG_BOT_TOKEN = get('NOTIFY_TG_BOT_TOKEN')
const NOTIFY_TG_CHAT_ID = get('NOTIFY_TG_CHAT_ID')

// 到秒的时间戳：同日重跑（排查问题、补跑）不再把当天完好的 dump 覆盖成可能残缺的新文件
const STAMP = new Date().toISOString().replace(/[:]/g, '').replace(/\..+/, '')
const produced = [] // 本轮产物（SHA256SUMS 清单用）
const fail = (msg) => { console.error(`[backup] FAIL: ${msg}`); notify(`备份失败：${msg}`).finally(() => process.exit(1)) }
const log = (msg) => console.log(`[backup] ${msg}`)

async function notify(text) {
  if (!NOTIFY_TG_BOT_TOKEN || !NOTIFY_TG_CHAT_ID) return
  try {
    await fetch(`https://api.telegram.org/bot${NOTIFY_TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: NOTIFY_TG_CHAT_ID, text: `[Mnemosyne 备份] ${text}`.slice(0, 4000) }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e) {
    console.error(`[backup] notify failed: ${e instanceof Error ? e.message : e}`)
  }
}

/** 防并发重入：schtasks 重叠/手动补跑同时执行会互相覆盖 STAMP 目录与清单。 */
const LOCK = join(BACKUP_ROOT, 'backup.lock')
function acquireLock() {
  mkdirSync(BACKUP_ROOT, { recursive: true })
  if (existsSync(LOCK)) {
    const pid = readFileSync(LOCK, 'utf8').trim()
    fail(`另一轮备份似在运行（pid=${pid}，backup.lock 存在）。确认无进程后删除该文件再试`)
  }
  writeFileSync(LOCK, String(process.pid))
}
function releaseLock() {
  try { unlinkSync(LOCK) } catch { /* 已被清理 */ }
}

/** 产物原子登记：先写 .tmp 再改名 + 记入清单。 */
function writeArtifact(dest, data) {
  const tmp = `${dest}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, dest)
  produced.push(dest)
  return dest
}

/* ---------- 1. Postgres（pg_dump custom 格式，pg_restore 可恢复）---------- */
async function backupPostgres() {
  if (!PGBACKUP_URL) {
    log('postgres：未配 PGBACKUP_URL，跳过（仅备 twig 时可接受；完整备份请开 Zeabur postgres 公网并补配）')
    return
  }
  mkdirSync(join(BACKUP_ROOT, 'pg'), { recursive: true })
  const out = join(BACKUP_ROOT, 'pg', `${STAMP}.dump`)
  const tmp = `${out}.tmp`
  const res = spawnSync(PGDUMP_BIN, [
    '--no-owner', '--no-privileges', '--format=custom',
    '--file', tmp,
    PGBACKUP_URL,
  ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10 * 60_000 })
  if (res.error?.code === 'ENOENT') {
    fail(`找不到 pg_dump（${PGDUMP_BIN}）。安装 PostgreSQL 客户端：winget install PostgreSQL.PostgreSQL.16，或在 backup.local.env 设 PGDUMP_BIN 指向 pg_dump.exe 全路径`)
  }
  if (res.status !== 0) fail(`pg_dump 退出码 ${res.status}：${res.stderr}`)
  renameSync(tmp, out)
  produced.push(out)
  log(`postgres → ${out}（${(statSync(out).size / 1024).toFixed(0)} KB）`)

  // 冒烟：pg_restore --list 能读出目录 = dump 结构完整可恢复（restore.md：备份未验证等于没有备份）
  const smoke = spawnSync(PGRESTORE_BIN, ['--list', out], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 })
  if (smoke.error?.code === 'ENOENT') {
    log(`⚠ pg_restore（${PGRESTORE_BIN}）不在 PATH——冒烟跳过。请补装客户端或设 PGRESTORE_BIN`)
  } else if (smoke.status !== 0) {
    fail(`pg_restore --list 冒烟失败（dump 可能损坏）：${smoke.stderr}`)
  } else {
    const entries = smoke.stdout.toString().split('\n').filter(l => l.includes('TABLE DATA')).length
    log(`postgres 冒烟 ✓（${entries} 张表带数据）`)
  }
}

/* ---------- 2. twig 叙事数据（经 BFF，凭证不出本机之外）---------- */
let clientKey = WEB_KEY ?? null

async function api(path, init = {}, retried = false) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'X-Client-Key': clientKey, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(120_000), // 远端 hang 住不该把 schtasks 挂到永远
  })
  if (res.status === 401 && !WEB_KEY) {
    // key 失效（如 web 端重新登录轮换了 client_key）→ 重登一次再重试；
    // 此前只把 clientKey 置空返回 null，调用方把字面 null 写进文件还打 ✓，备份静默变空
    if (retried) throw new Error(`${path} → 401（重登后仍被拒；master_key 可能已变更）`)
    clientKey = null
    await ensureKey()
    return api(path, init, true)
  }
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

async function ensureKey() {
  if (clientKey) return
  if (!BASE) fail('未配 MNEMOSYNE_BASE，twig 快照拉取不了')
  if (!WEB_KEY && !(ETERNAL_ID && MASTER_KEY)) fail('需配 MNEMOSYNE_WEB_KEY，或 MNEMOSYNE_ETERNAL_ID + MNEMOSYNE_MASTER_KEY')
  if (WEB_KEY) { clientKey = WEB_KEY; return }
  const res = await fetch(`${BASE}/v1/web/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // BFF schema 只收小写 64-hex；env 里手抄的大写会 400 掉整个 twig 备份
    body: JSON.stringify({ user_eternal_id: String(ETERNAL_ID).trim().toLowerCase(), master_key: MASTER_KEY }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) fail(`web/login ${res.status}: ${(await res.text()).slice(0, 200)}`)
  clientKey = (await res.json()).client_key
  log('已用 master_key 换取新 web client_key')
}

async function pullAll(pathBase, pageParam) {
  // 分页拉尽（state/notes 为 page/limit 语义）；非分页端点一次返回
  if (!pageParam) return api(pathBase)
  const out = []
  let first = null
  for (let page = 1; page <= 500; page++) {
    const sep = pathBase.includes('?') ? '&' : '?'
    const data = await api(`${pathBase}${sep}${pageParam}=${page}&limit=500`)
    if (first === null) first = data
    const items = Array.isArray(data?.items) ? data.items : Array.isArray(data?.notes) ? data.notes : Array.isArray(data?.fragments) ? data.fragments : null
    if (items == null) return data // 形状不带分页，直接返回
    out.push(...items)
    if (items.length < 500) break
  }
  // state 端点顶层是 state 对象 + fragments 分页（此前不认识该形状，只备份到第 1 页 500 条）
  if (first && Array.isArray(first.fragments)) return { ...first, fragments: out, totalFragments: out.length }
  return out
}

/** 快照非空断言：字面 null/空对象/0 字节的文件在这里拦下，不留「打 ✓ 的空备份」。 */
function assertNonEmpty(file, data) {
  const size = typeof data === 'string' ? data.length : JSON.stringify(data ?? '').length
  if (data == null || size < 2) throw new Error(`快照为空（${size} 字节）——凭证失效或上游异常`)
}

async function backupTwig() {
  await ensureKey()
  const dir = join(BACKUP_ROOT, 'twig', STAMP)
  mkdirSync(dir, { recursive: true })
  const targets = [
    ['context.json', '/v1/web/memory/context', null],
    ['claims.json', '/v1/web/memory/claims', null],
    ['audit-last.json', '/v1/web/memory/audit/last', null],
    ['journal.json', '/v1/web/memory/journal/export', null],
    ['soliloquy.json', '/v1/web/memory/soliloquy/export', null],
    ['state.json', '/v1/web/memory/state', 'page'],
    ['notes.json', '/v1/web/memory/notes', 'page'],
    ['stamps.json', '/v1/web/memory/stamps/recent?limit=200', null],
  ]
  for (const [file, path, pageParam] of targets) {
    try {
      const data = await pullAll(path, pageParam)
      assertNonEmpty(file, data)
      writeArtifact(join(dir, file), JSON.stringify(data, null, 1))
      log(`twig ${file} ✓`)
    } catch (e) {
      fail(`twig ${file}：${e.message}`)
    }
  }
  log(`twig → ${dir}/`)
}

/* ---------- 3. 校验和清单 ---------- */
function writeChecksums() {
  if (produced.length === 0) return
  const lines = produced.map(p => {
    const buf = readFileSync(p)
    return `${createHash('sha256').update(buf).digest('hex')}  ${p.split(BACKUP_ROOT).pop()?.replace(/^[\\/]/, '') ?? p}`
  })
  writeArtifact(join(BACKUP_ROOT, 'pg', `SHA256SUMS.${STAMP}.txt`), lines.join('\n') + '\n')
  log(`SHA256SUMS ✓（${produced.length} 个产物）`)
}

/* ---------- 4. 滚动清理 ---------- */
function prune(sub) {
  const dir = join(BACKUP_ROOT, sub)
  if (!existsSync(dir)) return
  const cutoff = Date.now() - RETAIN_DAYS * 86_400_000
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).mtimeMs < cutoff) {
      rmSync(p, { recursive: true })
      log(`prune ${sub}/${name}（>${RETAIN_DAYS} 天）`)
    }
  }
}

/** 日志自剪：schtasks 重定向的 backup.log 无限增长（prune 只清 pg/twig 子目录）。 */
function pruneLog() {
  const logFile = join(BACKUP_ROOT, 'backup.log')
  if (!existsSync(logFile)) return
  if (statSync(logFile).size > 5 * 1024 * 1024) {
    const tail = readFileSync(logFile, 'utf8').split('\n').slice(-2000).join('\n')
    writeFileSync(logFile, tail)
    log('backup.log 超 5MB，已截尾保留最后 2000 行')
  }
}

/* ---------- 主流程 ---------- */
const t0 = Date.now()
acquireLock()
backupPostgres()
  .then(backupTwig)
  .then(writeChecksums)
  .then(() => { prune('pg'); prune('twig'); prune('manifests'); pruneLog() })
  .then(() => { releaseLock(); log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`) })
  .catch((e) => { releaseLock(); fail(e instanceof Error ? e.message : String(e)) })
