/**
 * 调律页（settings）：客户端册实时接线（/v1/web/clients）。
 * 其余区（偏好/热线/ rituals）为设计稿——需要偏好读写端点后接，页脚已如实标注。
 */
import { api } from '../api.js'

const $ = id => document.getElementById(id)

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function badge(active) {
  return active ? '<span class="badge b-ok">active</span>' : '<span class="badge b-warn">revoked</span>'
}

function renderRows(clients) {
  const tbody = $('clientRows')
  if (!tbody) return
  if (!clients.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="stat-sub">还没有客户端——签发第一张牌。</td></tr>'
    return
  }
  tbody.innerHTML = clients.map(c => {
    const isSelf = c.client_type === 'web'
    const ops = []
    ops.push(`<button class="btn btn-ghost" data-act="rotate" data-id="${esc(c.id)}" style="padding:5px 10px;font-size:11px;">轮换 key</button>`)
    if (c.is_active && !isSelf) {
      ops.push(`<button class="btn btn-terra" data-act="revoke" data-id="${esc(c.id)}" style="padding:5px 10px;font-size:11px;">吊销</button>`)
    } else if (!c.is_active) {
      ops.push(`<button class="btn btn-ghost" data-act="restore" data-id="${esc(c.id)}" style="padding:5px 10px;font-size:11px;">恢复</button>`)
    }
    return `<tr>
      <td>${esc(c.client_type)}${isSelf ? ' <span class="sec-note">（本会话）</span>' : ''}</td>
      <td>${esc(c.display_name || '—')}</td>
      <td class="mono ${c.webhook_url ? '' : 'dim'}">${c.webhook_url ? esc(c.webhook_url.slice(0, 36)) + '…' : '—'}</td>
      <td>${badge(c.is_active)}</td>
      <td style="white-space:nowrap;text-align:right;">${ops.join(' ')}</td>
    </tr>`
  }).join('')
}

async function loadClients() {
  try {
    const data = await api('/v1/web/clients')
    renderRows(data.clients ?? [])
  } catch (e) {
    const tbody = $('clientRows')
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="stat-sub">加载失败：${esc(e.message)}</td></tr>`
  }
}

function showIssuedKey(key) {
  const panel = $('issuedKeyPanel')
  const value = $('issuedKeyValue')
  if (!panel || !value) return
  value.textContent = key
  panel.classList.remove('hidden')
}

async function issue() {
  const type = $('newClientType')?.value
  const name = $('newClientName')?.value?.trim() || undefined
  if (!type) return
  try {
    const data = await api('/v1/web/clients', { method: 'POST', body: { client_type: type, ...(name ? { display_name: name } : {}) } })
    $('newClientPanel')?.classList.add('hidden')
    showIssuedKey(data.client_key)
    await loadClients()
  } catch (e) {
    showIssuedKey(`签发失败：${e.message}`) // 复用面板当提示位
  }
}

function wire() {
  $('crisisLocal')?.addEventListener('change', e => {
    $('crisisLocalWarn')?.classList.toggle('hidden', !e.target.checked)
  })
  $('btnNewClient')?.addEventListener('click', () => {
    $('issuedKeyPanel')?.classList.add('hidden')
    $('newClientPanel')?.classList.remove('hidden')
  })
  $('btnCancelClient')?.addEventListener('click', () => $('newClientPanel')?.classList.add('hidden'))
  $('btnIssue')?.addEventListener('click', issue)
  $('clientRows')?.addEventListener('click', async e => {
    const btn = e.target.closest('button[data-act]')
    if (!btn) return
    const { act, id } = btn.dataset
    try {
      if (act === 'rotate') {
        const data = await api(`/v1/web/clients/${id}/rotate`, { method: 'POST' })
        showIssuedKey(data.client_key)
      } else if (act === 'revoke') {
        if (!confirm('吊销后该 key 立即失效；telegram 类型会一并停止 Huginn 出站投递。确定？')) return
        await api(`/v1/web/clients/${id}/active`, { method: 'POST', body: { active: false } })
      } else if (act === 'restore') {
        await api(`/v1/web/clients/${id}/active`, { method: 'POST', body: { active: true } })
      }
      await loadClients()
    } catch (err) {
      alert(`操作失败：${err.message}`)
    }
  })
}

wire()
loadClients()
