# 记忆女神 Mnemosyne：客户端接入与 AI 操作指南

本文面向使用者、接入开发者，以及协助部署和排查的 AI 助手。先选与你的问题有关的章节即可，不必先通读总设计文档。

核对日期：2026-09-27。实现基线：[67d5ad5](https://github.com/qimingjiu/twig-mnemosyne/commit/67d5ad562f68d0fc2dc3caf54c9f7915b7fc8b7f)。本文根据该版本的代码与文档整理；具体部署的模型、工具和服务可用性需要在自己的实例验收。

| 你想知道什么 | 从这里开始 |
|---|---|
| 和衔枝是什么关系，是不是只有自动路由 | [1. 项目分工](#1-项目分工) |
| 客户端怎么接、地址和密钥填哪里 | [2. 客户端接入](#2-客户端接入) |
| 一轮聊天里哪些操作会自动完成 | [3. 自动处理流程](#3-自动处理流程) |
| AI 怎么调用工具、怎么读写记忆 | [4. AI 操作与工具边界](#4-ai-操作与工具边界) |
| 跨端会话、模型切换和人设 | [5. 会话与模型](#5-会话与模型) |
| 加密以后怎么回答、私密内容以后还能不能被读取 | [6. 隐私边界](#6-隐私加密和本地模型的实际边界) |
| 想把安装或排查交给 AI | [7. 给 AI 助手的工作说明](#7-给-ai-助手的工作说明) |
| 已经接上但不工作 | [8. 排查与反馈](#8-排查与反馈) |

## 1. 项目分工

Mnemosyne 是一个单用户、自托管的个人 AI 运行时。它把聊天入口、用户身份、记忆、模型调用、工具和主动触达连在一起。

| 组件 | 负责什么 |
|---|---|
| [衔枝 twig-memory](https://github.com/qimingjiu/twig-memory) | 原始碎片、线索、认识层、反刍、反证与审计，生成叙事上下文包 |
| Mnemosyne runtime | 认证与会话、上下文预算及装配、模型调用链、缓存、工具执行回路、记忆摄入与反刍排程、Huginn 主动触达 |
| LiteLLM | 对接模型供应商或本地模型；Mnemosyne 决定主调用链 |
| MCP gateway | 连接和聚合服务端工具，供 runtime 调用 |
| Web / Telegram / 外部聊天客户端 | 用户输入与结果展示；不同入口共享同一运行时 |

**记忆引擎和运行时分别有自己的工程职责。** 记忆女神有防自强化相关处理，例如只把用户原话摄入记忆、上报主动干预；完整的反证与盲推导机制由衔枝承担。具体实现、近似和未完成项见 [status.md](status.md) 与 [upstream.md](upstream.md)。

## 2. 客户端接入

### 2.1 先区分两种接法

| 目标 | 连接方式 | 获得什么 |
|---|---|---|
| 使用完整记忆女神运行时 | 外部聊天客户端连接 Mnemosyne 的 OpenAI 兼容 API；也可用 Web 或 Telegram | runtime 统一处理记忆装配、模型调用和后续摄入 |
| 只给现有 AI 挂衔枝记忆工具 | 按 [twig-memory 服务端文档](https://github.com/qimingjiu/twig-memory/blob/main/server/README.md) 连接衔枝 MCP | 由宿主 AI 按衔枝接入约定读写记忆，不等于经过 Mnemosyne |

Mnemosyne 的聊天入口是 `/v1/chat/completions`。本仓库里的 `mcp-gateway` 是服务端工具网关；不要把它的内网地址填进聊天客户端的模型 API 地址，也不要把衔枝 MCP 地址当作记忆女神聊天地址。

### 2.2 服务与身份准备

还未部署时，先按 [README 快速开始](../README.md#快速开始) 或 [Zeabur 手册](../deploy/zeabur.md) 启动服务。部署者完成一次 bootstrap 后会得到：

| 名称 | 用途 | 填到普通聊天客户端吗 |
|---|---|---|
| `eternal_id` | 用户标识；服务端据此关联上游记忆 | 通常不需要；注册客户端或 Web 登录会用到 |
| `master_key` | 签发客户端凭证、Web 登录所用的用户主口令 | 不填到模型 API Key 栏 |
| `client_key`，形如 `mn_…` | 客户端请求 runtime 的凭证 | 填到 API Key 栏 |
| 模型供应商 API key | runtime 经 LiteLLM 调用上游模型 | 配置在服务端，不作为 Mnemosyne 客户端密钥 |

bootstrap 首次签发的是 `web` 类型客户端。其他客户端可以通过 `POST /v1/identity/register` 注册到同一个用户，例如以下请求体：

```json
{
  "user_eternal_id": "REPLACE_WITH_64_HEX_ETERNAL_ID",
  "client_type": "rikkahub",
  "display_name": "我的聊天客户端",
  "credential": {
    "type": "master_key",
    "master_key": "REPLACE_WITH_YOUR_MASTER_KEY"
  }
}
```

将占位符替换为自己的值，经自己的 HTTPS 接口提交。成功响应包含 `client_key` 和 `eternal_session_id`；妥善保存密钥，不要把带密钥的请求或响应发到群聊、Issue 或 AI 对话中。

当前允许的 `client_type`：`operit`、`rikkahub`、`telegram`、`web`、`mobile`、`api`。这些是注册分类，并不等于对每款客户端、每个版本都完成了兼容认证。

每个用户的同一种 `client_type` 只能注册一次。收到 `409 client_exists` 时，使用已有凭证；确需轮换时调用 `POST /v1/identity/rotate`，该客户端的旧密钥会失效。不要用重复 bootstrap 解决客户端注册问题。

实现：[bootstrap.ts](../runtime/scripts/bootstrap.ts)、[身份路由](../runtime/src/http/routes.ts)、[身份服务](../runtime/src/identity/service.ts)。

### 2.3 OpenAI 兼容客户端怎样填

以能够自定义供应商地址的聊天客户端为例：

| 设置项 | 填法 |
|---|---|
| 接口类型 | OpenAI 兼容 / Chat Completions |
| Base URL | `https://你的运行时域名/v1` |
| API Key | 当前客户端的 `mn_…` 密钥 |
| 模型 | 从该实例的 `/v1/models` 读取，选择服务端已经配置供应商密钥的模型 |
| 流式输出 | 支持 `stream: true`；客户端需支持 OpenAI SSE |
| 自定义认证头 | 可用 `X-Client-Key: mn_…`；通常标准 `Authorization: Bearer mn_…` 已足够 |

以**最终请求 URL**为准：模型列表是 `/v1/models`，对话是 `/v1/chat/completions`。有的客户端会自动追加 `/v1`，应避免变成 `/v1/v1/chat/completions`；要求填写完整端点的客户端则填完整路径。当前入口不是 `/v1/responses`。

返回模型列表仅代表该模型在注册表中，不保证它的供应商密钥、配额或本地模型服务已就绪。

可以先用终端验证链路，排除客户端界面配置的问题。以下为 Bash 示例，替换两个占位值；真实密钥只在自己的终端使用：

```bash
MNEMOSYNE_URL='https://your-runtime.example'
MNEMOSYNE_CLIENT_KEY='mn_REPLACE_WITH_YOUR_CLIENT_KEY'

curl --fail-with-body "$MNEMOSYNE_URL/health"

curl --fail-with-body "$MNEMOSYNE_URL/v1/models" \
  -H "Authorization: Bearer $MNEMOSYNE_CLIENT_KEY"

curl --fail-with-body "$MNEMOSYNE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $MNEMOSYNE_CLIENT_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary '{"messages":[{"role":"user","content":"你好，请简短回复，测试连接。"}],"stream":false}'
```

最小请求可以省略 `model`，使用服务端默认调用链。客户端必须选择模型时，使用模型列表返回的准确 ID。上述测试会产生真实模型调用和一条测试对话；`/health` 本身不验证供应商能否实际回答。

### 2.4 Web 和 Telegram

**Web Dashboard**：打开部署好的 Web 域名，使用现有 `client_key`，或者用 `eternal_id + master_key` 登录。后一种方式会重新签发 Web 凭证，旧 Web 凭证失效。Web 控制台已经接入真实聊天；记忆书、论断否决和碎片修正也有真实接口。部分其他页面仍是静态稿，见 [Web 接入状态](../web/README.md#页面接入状态)。

**Telegram**：配置 `TELEGRAM_BOT_TOKEN`，给 bot 发一条私聊消息，再由部署者使用 [telegram-bind.ts](../runtime/scripts/telegram-bind.ts) 对应的 CLI 绑定该 `chat_id`。未绑定私聊会被忽略；当前适配器处理私聊文本，不处理群聊。它直接调用同一套聊天主管线。

绑定脚本当前将主动触达 webhook 写为 Zeabur 内网地址。使用其他部署方式时，需要按自己的网络核对该地址及 webhook 配置；不要只验证 bot 能被动回答，就认定主动触达也已接通。

## 3. 自动处理流程

当消息通过记忆女神的聊天入口进入时，普通对话按下列职责处理；危机响应、缓存命中、工具续轮等路径会有相应分支。

| 阶段 | runtime 自动做什么 |
|---|---|
| 认证与会话 | 校验客户端凭证，找到所属用户和服务端会话 |
| 记录与决策 | 保存当前消息，进行任务意图分类、隐私评分，选择主模型调用链 |
| 上下文装配 | 读取衔枝叙事上下文、服务端近期历史和用户级设定，按目标模型窗口装配 |
| 回答与工具 | 调用模型；服务端工具进入执行回路，客户端工具回交客户端执行 |
| 后续摄入 | 新用户轮的原话异步交给衔枝；AI 回复不作为用户事实摄入，工具续轮跳过重复摄入 |
| 定期维护 | runtime 按排程为近期活跃用户请求衔枝反刍，生成或更新认识等内容 |

所以，已经通过 runtime 聊天时，用户无需每轮手动说“请读取记忆”“请存储记忆”，宿主也不应再无条件重复调用衔枝摄入工具。单独挂衔枝 MCP 的接法另有宿主责任，见第 2.1 节。

**摄入与反刍不是同一个完成时点。** 回答返回后，异步摄入可能尚未完成；认识层也不保证每句话之后立即更新。当前反刍默认开启，`REFLECT_CRON` 默认 `30 18 * * *`，按服务器时区执行（服务器为 UTC 时对应北京时间次日 02:30）；`REFLECT_ACTIVE_HOURS` 默认 24。设 `REFLECT_ENABLED=0` 可关闭 runtime 排程。部署时避免再无意启用上游另一套自动排程。

反刍请求使用异步模式，`queued` 说明任务已被接受；完成情况还要看 Twig 日志与状态。聊天客户端自己的旧记录也不会因为整段放进 `messages`，就自动批量导入为长期记忆；旧记录迁移使用专门的 [relocate CLI](../runtime/scripts/relocate.ts)。

实现：[聊天主管线](../runtime/src/chat/pipeline.ts)、[上下文装配](../runtime/src/context/builder.ts)、[摄入](../runtime/src/memory/ingestion.ts)、[反刍排程](../runtime/src/memory/reflectScan.ts)、[排程配置](../runtime/src/config.ts)。

## 4. AI 操作与工具边界

### 4.1 哪些工具由谁执行

| 情况 | 执行方式 |
|---|---|
| 服务端已配置的能力 | runtime 根据任务泳道及能力配置提供工具 schema，经 MCP gateway 执行并将结果回给模型 |
| 客户端在请求中声明的 function 工具 | runtime 回传 `tool_calls`，由客户端执行；客户端再携带对应 `tool_call_id` 的结果续轮 |
| 新的远程 MCP 服务 | 可通过 registry 能力注册明确的服务地址；可用性和调用权限取决于实际服务、凭证及配置 |
| 只有名称、没有配置或无法访问的工具 | 不能仅凭模型说“我能用”视为已接通 |

工具能力表在 [capabilities.yaml](../config/capabilities.yaml)，网关服务清单在 [config.default.json](../mcp-gateway/config.default.json)。邮件、日历等需要对应服务和授权；在能力表里出现不代表凭证已经配置。

模型可能收到 `confirmation_required`、`contested_ask_user_first` 等待确认结果。应向用户说明待执行事项，在操作得到实际成功结果前不要声称已经完成。客户端工具的权限与确认由执行它们的客户端负责，不能假定服务端网关已经代为执行或确认。

工具回路不会保证任意服务、任意模型都支持所有工具；厂商原生的非 function 工具还受模型注册表开关限制。实现见 [工具解析](../runtime/src/tools/resolver.ts) 和 [聊天主管线](../runtime/src/chat/pipeline.ts)。

### 4.2 读写记忆的入口

模型通过 runtime 装配得到衔枝上下文；管理和纠正记忆可以使用 Web 界面，或以下已认证的接口：

| 操作 | 方法与路径 | 请求体 |
|---|---|---|
| 查看当前叙事上下文 | `GET /v1/web/memory/context` | 无 |
| 查看认识论断 | `GET /v1/web/memory/claims` | 无 |
| 查看最近审计 | `GET /v1/web/memory/audit/last` | 无 |
| 否决某条论断 | `POST /v1/web/memory/claims/contest` | `{"claim_id":"实际ID","note":"否决理由"}` |
| 给碎片追加本人修正 | `POST /v1/web/memory/correct` | `{"fragment_id":"实际ID","note":"修正说明"}` |
| 写用户便签 | `POST /v1/web/memory/notes` | `{"content":"用户要记录的内容"}` |

这些接口使用当前用户的 `client_key`；用户身份由 runtime 从凭证确定，不需要提交其他人的 `userId`。先读取实际 ID，再提交用户明确要求的更正。碎片修正保留原文并追加标注，论断否决遵循衔枝的 contested 语义。

上述是 HTTP 接口，**不会因为 AI 看到了本文就自动变成它可调用的工具**。协助操作的 AI 需要宿主提供 HTTP、终端或对应工具权限。日记、心迹、便签、印章的用户界面和工具注册表也有各自边界，不能凭名称虚构工具。

实现：[Web BFF 路由](../runtime/src/http/webRoutes.ts)、[TwigAdapter](../runtime/src/memory/TwigAdapter.ts)。

## 5. 会话与模型

**跨客户端连续性**：多个客户端应注册到同一 `eternal_id`。未传自定义会话头时，runtime 默认使用该用户最近活跃的 `personal` 会话；Web 控制台与 Telegram 目前都采用此方式。

开发者可以通过 `X-Eternal-Session-Id` 指定服务端会话，或通过 `X-Session-Type` 选择 `personal`、`coding`、`research`、`roleplay` 类型。需要固定共享会话时，可以使用 `/v1/identity/session` 返回的 `eternal_session_id`，不要每轮随机生成。客户端本地的“新聊天”按钮未必会创建新的服务端会话。

**会话分开不等于长期记忆隔离。** 当前上游叙事包按用户身份读取，而近期聊天历史按服务端会话读取。不要用“新建一个 coding 会话”代替隐私隔离。

**任务泳道与模型选择**：`chat / coding / research / tool` 分类目前主要用于选择可见工具；不代表每种任务固定切换到一款专用模型。请求的 `model` 只有在注册为云端模型且本轮路由允许时才成为首选，其余情况遵循默认调用链、隐私或危机路径。失败回退会按下一模型重新装配上下文。

**人设与客户端 system prompt**：当前上下文主要由 runtime 重新装配，新用户轮不会把客户端提交的整段 `system` 与旧历史原样代理到上游。统一设定读取 `users.preferences.persona_prompt`；部署者可通过 [persona CLI](../runtime/scripts/persona.ts) 查看或设置。仅修改客户端本地人设，不保证改变服务端实际使用的人设。

实现：[会话解析](../runtime/src/identity/service.ts)、[模型注册表](../runtime/src/context/modelRegistry.ts)、[任务分类](../runtime/src/router/lanes.ts)、[装配器](../runtime/src/context/builder.ts)。

## 6. 隐私、加密和本地模型的实际边界

### 加密以后怎样回复

存储加密保护落盘的数据，授权读取时由相应组件解密；本项目没有实现让 LLM 直接对密文进行语义推理。应用层的 AES-256-GCM 用于凭据、危机审计等数据；普通聊天内容当前直接写入 `conversation_messages.content`，Twig 数据卷的静态加密由部署层承担。设置 `ENCRYPTION_KEY` 不等于已经给全部聊天和全部数据卷启用加密。

### 怎样决定本地还是云端

隐私评分由服务端规则计算，包括显式 `metadata.privacy: "high"`、PII 检测和情感词表；默认阈值为 70。显式 high 标记可使普通请求的主回答链进入本地路径。PII 单项评分有上限，不能把“出现手机号”理解为“一定自动转本地”。任务意图分类是另一条逻辑，当前调用云端分类模型。

本地路径需要可访问的 Ollama 模型服务，可以部署在自有设备或同机侧车；只填写 `privacy: high` 不会自动安装本地模型。本地主回答链不可用时返回 `503 privacy_unavailable`，该链不会回退云端。危机响应有单独策略，当前主管线选择云端强模型；不要把普通隐私路由描述成所有路径的绝对承诺。

### 本地回答后，内容以后还会被读取吗

**目前会保留进入后续上下文的可能，不能承诺“私密内容之后不再被检索”，也不能承诺全流程都留在本地。** 在本次核对版本中：

1. 普通新用户轮先执行意图分类，再计算隐私分数。分类器会把当前消息片段和近期历史提交到配置为云端的 `deepseek-flash`；本地主回答路由未覆盖这个前置调用。
2. 隐私评分当前只检查本轮消息与请求 metadata，没有对装配后的完整上下文重新评分。
3. 新用户轮的原话仍异步摄入衔枝，调用未传递隐私级别；近期历史读取也未按隐私等级过滤。随后走云端的请求可能带上之前的相关内容。

这些是已定位的实现边界，文档补充本身不等于修复完成。严格本地隔离需要继续覆盖前置分类、记忆摄入与召回、后续上下文及其他外部调用。这里的静态代码核对不能证明某个部署实例是否发生过实际外发。

依据：[隐私评分](../runtime/src/privacy/score.ts)、[意图分类](../runtime/src/router/lanes.ts)、[主管线](../runtime/src/chat/pipeline.ts)、[历史读取](../runtime/src/memory/recent.ts)、[摄入](../runtime/src/memory/ingestion.ts)、[加解密](../runtime/src/util/crypto.ts)。设计背景见 [总设计文档 §20](Mnemosyne_Technical_Implementation_Document_v0.3.0_complete.md#20-privacy-tiered-routing--local-model-sidecar整节新增)。

## 7. 给 AI 助手的工作说明

需要 AI 带你部署、接入或排查时，可把下面这段连同仓库地址交给它：

```text
请协助我使用 qimingjiu/twig-mnemosyne。

先读取 README.md、docs/CLIENT-AND-AI-GUIDE.md、docs/status.md，
部署问题再读 deploy/zeabur.md 或 docker-compose.yml。
检查当前版本与我实际部署版本，不把设计目标、已实现功能和已验证效果混为一谈。

先确定我的目标：完整 runtime 接入、单独衔枝 MCP、客户端工具，还是服务端工具。
核对我提供的部署方式、客户端类型及去掉凭证后的错误信息。
密钥只在我的本地环境或部署平台配置，不要求我把真实密钥发进对话或提交仓库。

按 health → 认证与会话 → models → 一轮真实聊天 → 工具/记忆状态的顺序排查。
health 返回正常、模型已登记、请求被排队，都不能代替对应功能的实际成功结果。
接口、字段和工具名应从代码核对，不虚构 API；没有操作工具或执行权限时明确说明。
日常聊天走 runtime 时，不额外重复摄入同一用户轮；旧历史迁移使用专门迁移流程。
遇到设计与实现差异，标明出处和影响，不把尚未修复的行为当成已有保证。

需要更改时，先说明具体改动和影响，遵循我已经给出的授权范围；
不要因排查而擅自清空记忆、重建用户、轮换密钥或扩大网络暴露范围。
结束时报告实际执行了什么、如何核验、还有哪些未完成项。
```

这段用于约束协助者的工作流程；实际运行能力来自已部署的代码、服务和凭证配置。

## 8. 排查与反馈

| 现象 | 优先检查 |
|---|---|
| `401` | 是否填写本实例签发的 `client_key`；是否已轮换；不要把模型厂商 key 或 `eternal_id` 当作 API Key |
| `404` | 最终 URL 是否重复 `/v1`，是否错用了 `/v1/responses`，域名反代是否指向 runtime |
| `409 client_exists` | 同类型客户端已经注册；使用原凭证，或按需求轮换 |
| 能打开网页但看不到数据 | Web 的 `MNEMOSYNE_UPSTREAM`、登录凭证与 `/v1/*` 反代 |
| `/v1/models` 成功但聊天失败 | 供应商密钥、配额、模型别名、LiteLLM 和 runtime 的默认调用链 |
| 工具不执行 | `/health` 中 `mcp` 是否为 `ok:<数量>`；顶层 `ok: true` 不代表 MCP 必然可用；再检查工具授权、待确认状态及客户端是否支持工具续轮 |
| Telegram 不回复 | bot token、轮询状态、私聊类型、`chat_id` 是否绑定；查看已脱敏的日志 |
| 认识层一直空白 | Twig 摄入是否成功、近期是否有用户消息、runtime 反刍排程是否启用、异步任务是否真正完成 |
| 跨端没有预期的近期历史 | 是否同一用户、是否指定不同的服务端会话；不要只比较客户端本地聊天标题 |
| `503 privacy_unavailable` | 本地主模型服务是否就绪；该错误不会自动切换主回答到云端 |

仍需反馈时，请附：仓库 commit / 部署版本、客户端及版本、相关文档章节、预期与实际结果、去掉密钥和个人内容后的最小请求及错误信息。问题落在具体行为上，就更容易复现和处理。

继续阅读：[实现状态](status.md) · [上游契约](upstream.md) · [测试说明](testing.md) · [恢复手册](restore.md)。
