#!/usr/bin/env node
/**
 * check-litellm-parity.mjs — LiteLLM 双配置一致性检查（CI 门）。
 *
 * deploy/compose/litellm.yaml 与 deploy/litellm/config.yaml 是同一套模型注册表的两份手抄，
 * 曾因人肉同步漂移出「fallback_strategy 是 litellm 不认识的键、整段被静默忽略」的事故
 * （compose 版修了，Zeabur 版没同步）。本脚本拦住下一 drift：
 *   1. 两份文件的 model_name 集合必须一致；
 *   2. router_settings 里两份文件的键集合必须一致（fallbacks 等拼写差异在这里现形）。
 *
 * 刻意零依赖：行级正则足够，不引 yaml 库。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const files = {
  compose: join(here, '..', 'deploy', 'compose', 'litellm.yaml'),
  zeabur: join(here, '..', 'deploy', 'litellm', 'config.yaml'),
}

function parse(file) {
  const text = readFileSync(file, 'utf8')
  const modelNames = new Set([...text.matchAll(/^\s*- model_name:\s*([^\s#]+)/gm)].map(m => m[1]))
  // router_settings 块：从 `router_settings:` 到下一个同缩进顶层键
  const routerKeys = new Set()
  const start = text.search(/^router_settings:\s*$/m)
  if (start >= 0) {
    const block = text.slice(start).split('\n').slice(1)
    for (const line of block) {
      if (/^\S/.test(line)) break // 下一个顶层键，块结束
      const item = /^\s+- ([A-Za-z_]+):/.exec(line) // 列表型键（fallbacks: - gpt-4o: ...）
      const plain = /^\s+([A-Za-z_]+):/.exec(line)
      const key = item?.[1] ?? plain?.[1]
      if (key) routerKeys.add(key)
    }
  }
  return { modelNames, routerKeys }
}

const compose = parse(files.compose)
const zeabur = parse(files.zeabur)
const problems = []

const diff = (a, b, label) => {
  for (const x of a) if (!b.has(x)) problems.push(`${label} 只在 compose 版出现: ${x}`)
  for (const x of b) if (!a.has(x)) problems.push(`${label} 只在 zeabur 版出现: ${x}`)
}

diff(compose.modelNames, zeabur.modelNames, 'model_name')
diff(compose.routerKeys, zeabur.routerKeys, 'router_settings 键')

if (problems.length > 0) {
  console.error('[litellm-parity] 两份 litellm 配置漂移了——人肉同步又输了：')
  for (const p of problems) console.error(`  - ${p}`)
  console.error('请同步 deploy/compose/litellm.yaml 与 deploy/litellm/config.yaml 后重试。')
  process.exit(1)
}
console.log(`[litellm-parity] ok：${compose.modelNames.size} 个模型、router_settings 键集一致`)
