/**
 * 观象台（observatory）：四张水位卡接 /v1/web/metrics/summary（24h 真实用量）。
 * 分岔图与 checkpoint 表是 LangGraph 规划示意——页脚已如实标注。
 */
import { api } from '../api.js'

const $ = id => document.getElementById(id)
const setText = (id, v) => { const el = $(id); if (el) el.textContent = v }

async function loadWaterLevel() {
  try {
    const m = await api('/v1/web/metrics/summary')
    setText('obs-requests', String(m.requests_total ?? 0))
    setText('obs-errors', String(m.errors_total ?? 0))
    setText('obs-latency', m.avg_latency_ms != null ? `${m.avg_latency_ms}ms` : '—')
    setText('obs-cache-rate', `${Math.round((m.cache_hit_rate ?? 0) * 100)}%`)
    setText('obs-tokens', `${((m.tokens?.in ?? 0) + (m.tokens?.out ?? 0)).toLocaleString()}`)
    setText('obs-cache-saved', (m.tokens?.saved ?? 0).toLocaleString())
    setText('obs-cost', `$${(m.cost_usd ?? 0).toFixed(4)}`)
  } catch {
    for (const id of ['obs-requests', 'obs-cache-rate', 'obs-tokens', 'obs-cost']) setText(id, '—')
  }
}

loadWaterLevel()
