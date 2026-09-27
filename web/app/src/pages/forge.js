/**
 * 锻炉页（forge）：MCP 网关三卡实时接线（/v1/web/mcp/health → gateway /health）。
 * 数据源含 per-server connected / tools / last_error（尸检名单）；其余区为静态设计稿。
 */
import { api } from '../api.js'

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const BROKER_CARD = `
  <div class="card card-pad">
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <b style="font:600 13px var(--f-serif);color:var(--ink)">Token Broker 取件</b>
      <span class="badge b-ghost">armed · idle</span>
    </div>
    <div class="kv mt8"><span class="k">模式</span><span class="v">§5.3 · 内部短票</span></div>
    <div class="kv"><span class="k">存储</span><span class="v">AES-256 · Postgres</span></div>
    <div class="kv"><span class="k">审计</span><span class="v">每次取件落账</span></div>
    <div class="kv"><span class="k">状态</span><span class="v">oauth_tokens 暂无写入方——首个 OAuth 型 MCP server 接入时启用</span></div>
  </div>`

function serverCard(s) {
  const live = s.enabled !== false && s.connected
  const badgeCls = s.last_error ? 'b-warn' : live ? 'b-ok' : 'b-ghost'
  const badgeText = s.last_error ? 'error' : live ? 'connected' : s.enabled === false ? 'disabled' : 'lazy'
  const type = s.type === 'builtin' ? '内置' : s.type === 'remote' ? '远程' : '本地 · stdio'
  const err = s.last_error ? `<div class="kv"><span class="k">last_error</span><span class="v" style="color:var(--terra)">${esc(String(s.last_error).slice(0, 80))}</span></div>` : ''
  return `
  <div class="card card-pad">
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <b style="font:600 13px var(--f-serif);color:var(--ink)">${esc(s.name)}</b>
      <span class="badge ${badgeCls}">${badgeText}</span>
    </div>
    <div class="kv mt8"><span class="k">来源</span><span class="v">${type}</span></div>
    <div class="kv"><span class="k">工具数</span><span class="v">${s.tools ?? '未拉取（懒连接）'}</span></div>
    <div class="kv"><span class="k">lazy loading</span><span class="v">首次调用拉起</span></div>
    ${err}
  </div>`
}

async function loadGateway() {
  const box = document.getElementById('mcp-cards')
  if (!box) return
  try {
    const data = await api('/v1/web/mcp/health', { timeoutMs: 8_000 })
    const servers = (data.servers ?? []).filter(s => s.name !== 'registry') // registry 自工具已在能力注册表，不重复占卡
    box.innerHTML = servers.map(serverCard).join('') + BROKER_CARD
  } catch (e) {
    box.innerHTML = `<div class="card card-pad"><div class="stat-sub" style="color:var(--terra)">网关不可达：${esc(e.message)}</div></div>` + BROKER_CARD
  }
}

loadGateway()
