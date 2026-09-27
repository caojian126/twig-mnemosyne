# CHANGELOG

Mnemosyne 记忆女神的版本编年史。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [v1.1.0] — 2026-09-28

全仓复审收口 + 衔枝同步。五个实锤 bug 清剿、触达回应闭环落地、观测面从「永远健康」修到诚实，测试 184/184（runtime 177 + mcp-gateway 7，单测口径；集成测试需真实 PG，本批未跑）。

### Fixed · 实锤 bug 清剿

- **TG 触达投递必 403**：deliver.ts 漏带 `X-Broker-Token`，Huginn 触达被自家 `/internal/outbound/telegram` 守卫拒绝、重试耗尽后 `delivery_exhausted`——补头 + 端到端投递测试
- **限流语义失真**：Fastify 未设 trustProxy，反代后 `req.ip` 恒为代理 IP——`ip:` 240/min 退化成全体共享桶，登录尝试限流可被用来锁死他人；`TRUST_PROXY_HOPS` 配置化（默认 1）
- **错误率观测全瞎**：`usage_logs.error` 恒 false（失败请求从不落 usage 行），errors_total / error_rate 永远为 0——失败路径补 error 记录，幂等兜底
- **mcp-gateway 零鉴权**：`/register` `/call` `/tools` 无校验 + 监听 0.0.0.0——内网可污染工具面 / SSRF 跳板；配置 `BROKER_INTERNAL_TOKEN` 即全端点要票，runtime 客户端同步带票
- **Zeabur 版 fallback 链从未生效**：`deploy/litellm/config.yaml` 用不被 litellm 识别的 `fallback_strategy`（compose 版已修、Zeabur 版漂移）；移植 `fallbacks` 并新增 `scripts/check-litellm-parity.mjs` 一致性 CI 门

### Added

- **触达回应闭环**（docs/upstream.md deferred 项）：deliver 带 dedupe_key → 内部落点反查 claim_id → TG 按 message_id 落回应映射 → 用户回复触达消息即上报 `outcome='user_engaged'` 消费 remention 邀请
- **TG 轮询并发化**（记档项收口）：per-chat 串行保序 + 全局有界并发（`TG_MAX_CONCURRENCY`，默认 4）；429 按 retry_after 退避重试；去重键 TTL 120s→300s
- **成本计价**：MODEL_REGISTRY 挂参考价（中转/套餐内不填则记 null，不假装免费），finalize 计 cost_usd，`mnemosyne_cost_usd` 计数器激活
- **settings 客户端册接真**：`/v1/web/clients` 列表/签发/轮换/吊销（user_id 钉死、web 自吊销防护、is_active 从此有写入方）；console 加 Huginn 出站面板（近 7 天状态计数 + 触达记录，claim 脱敏）；forge 三卡接 `/v1/web/mcp/health`；observatory 水位卡接 24h 真实用量
- **mcp-gateway 观测与加固**：per server/tool 调用指标（/metrics）；allTools 并行聚合；调用超时与 TTL 配置化；优雅停机；skill_document 透传收口（/tools 增 skill_documents，runtime 注入工具描述）；首次拥有测试套件
- **CI**：runtime / mcp-gateway / web / litellm 双配置一致性 / compose 配置校验（.github/workflows/ci.yml）
- **运维面**：compose 全栈 healthcheck + depends_on 条件启动 + 日志轮转 + 内存上限；Grafana provisioning（datasource + 面板）与四条告警规则；`/metrics` 双层收敛（Caddy 403 + 可选 METRICS_TOKEN）
- **反刍可观测**：scanned 计数、单轮耗时直方图、`outcome=queued` 语义修正；`npm run huginn -- --once reflect` 调试入口
- **备份链加固**：时间戳到秒防同日覆盖、原子改名、SHA256SUMS 清单、pg_restore --list 冒烟、快照非空断言、失败 TG 通知、fetch 超时、防重入锁

### Fixed · 其他

- 生产环境 CONFIRM_SECRET / BROKER_INTERNAL_TOKEN 保留 insecure-dev 默认值即拒启；TTS 键入 zod 统一校验
- 吞异常簇全部可见：twig packet 失败 / 候选扫描放弃 / 泳道分类降级 / huginn.yaml 损坏回默认 / 非法 cron / 触达生成全链落兜底
- restore.md：修容器名硬编码（compose exec）、补 backup-local（custom 格式 pg_restore）恢复路线与演练记录表
- compose env 透传修正：SILICONFLOW_API_KEY 给 mnemosyne（TTS 兜底链）、mcp-gateway 补 SEMANTIC_SCHOLAR_API_KEY 等、删死 GOOGLE_TTS_API_KEY / QDRANT_URL 注入
- 死代码清剿：ProviderHealthMonitor / ttsCharsThisMonth / opusscript / void 压制；outbox 补报统一走 `ingestion.reportIntervention`（§3.6 单一入口）
- webLogin 轮换即恢复 is_active；recent 排序补 id tie-breaker；确认票 pending 键加 fnName 维度；listTools 单请求缓存；env shadowing 改名；.env.example 清死变量补漏变量
- web：版本牌经 Vite define 注入（v0.3.1 假牌退役）、api() 带超时、observatory/forge 页脚诚实化

### Upstream

- 衔枝 twig-memory 刷新至 `00c1aca`：outcome/evidenceLevel 与 reflect async=1 已推送，与宿主对齐无契约变化；host-loop 缓存策略（叙事包挪本轮 user 消息头部）与宿主 R0–R4 口径一致；CRISIS_LEXICON 未变，vendor 词表继续有效

---

## [v1.0.0] — 2026-09-04

首个正式发布。单用户、自托管的 Personal AI Runtime：跨客户端、跨会话、跨模型的连续身份运行时。
*Your memory never dies. (And now the outbox always delivers.)*

### 施工账

- 设计文档链 v0.1.0 → v0.3.1（2026-08-29 ~ 08-30），两轮红队审计（18 + 14 项）全部裁决、修复并整合落盘
- 仓库 2026-08-30 开建 → 2026-09-04 封印，共 6 个施工日
- 测试 154/154 全绿（vitest 单测 + 需真实 PostgreSQL 的集成测试）

### Added · 能力总览

- **身份层**（§2）：argon2id + client_signature 双凭证、per-client_key 隔离、凭证轮换、session 归属校验、尝试限流
- **上下文装配**（§3/§6.4）：token 预算模型、原子 promptText、超预算重装配 fallback；Context Builder 是大脑
- **缓存**（§7）：Exact / Context / Policy 多层缓存；装配 stable→volatile 布局对齐厂商前缀缓存（Anthropic cache_control 只标稳定段）
- **危机协议**（§3.9/§18）：多语言词表预扫、零缓存路径、GREATEST monotonic 静默期、加密独立审计、TG 全链失败时静态危机资源兜底
- **隐私分层路由**（§20）：隐私评分 + PII 检测，本地 lane fail-closed（503 绝不 fallback 云端）
- **Huginn 主动触达**（§19）：分布式状态机 + 事务发件箱、原子抢槽、幂等投递（dedupe_key）、Final Policy Check、六道门、防自强化回路
- **工具系统**（§4/§5/§10）：MCP 网关懒连接聚合、动态注册 write-through 快照（重启读回 + 懒重握手 + lastError 尸检）、确认票据、Token Broker 短票、`origin=client` 工具透传（续轮 trailing 分角色去重落库、缓存/摄入全关）
- **模型网关**（§6）：LiteLLM 多厂商路由、fallback 链、temperature 收敛（reasoning 型锁 1）、真流式（上游 token 级 SSE 透传，已发 delta 禁换腿）
- **语音**（§21）：TTS 云端优先链（ElevenLabs）、语义截断、60s 即焚、独立情绪分类器（与隐私评分解耦）
- **记忆**（§8/§23）：上游 twig-memory（衔枝）三层叙事 + 情感层，promptText 原子注入；记忆搬家 CLI
- **Web Dashboard**：爱琴海之夜（index / book / explorer / console 实时接入；记忆写操作 contest / correct / notes 三条 BFF，userId 钉死认证用户）；console 对话面直连真流式——「前端也是客户端」成立
- **OpenAI 兼容面**：`/v1/models` + `/v1/chat/completions`（流式/非流式），RikkaHub 等标准客户端可直连
- **可观测**（§11）：prom-client 指标、PII 日志脱敏、latencySeconds 五段计时（crisis_prescan / twig_packet / assemble / gateway_first_byte / request_total）
- **部署运维**：docker compose 全栈（profiles：vector-kg / monitoring / local-lane 默认不启）、Zeabur 部署手册、本地备份脚本（pg_dump + twig 叙事快照，14 天滚动）、灾难恢复手册

### Fixed · 发布前清剿（0903–0904 三批）

- 主管线：缓存 try 圈收窄（防上游失败整链重跑导致重复流式/双倍计费）；当前用户消息不再重复进装配；fallback 后装配与缓存键按 usedModel 配对；ContextTooSmallError 链内跳过；工具轮用量合计
- 流式：SSE 尾帧与 decoder 冲刷、CRLF 容忍、中途超时重分类 504；回放层按 id 配对清洗悬空 tool_calls
- Huginn：delivery_pending 打捞归 Outbox Worker（retry_backoff + dedupe_key 幂等）；UTC 跨日竞态；ritual cron 用用户时区；inQuietHours「24:00」怪癖归零
- 依赖：undici 降级 ^6（node:20-alpine 与 undici v8 不兼容的 CrashLoop 根因）
- mcp-gateway：懒连接单飞、probe 入池、readBody 1MB 上限、工具列表按 server 名去重（同名 function 永不进系统提示）

### Security

- webhook 校验链：SSRF 全链校验 + DNS rebinding 钉扎（pinnedLookup 把解析→校验→连接收敛进同一次 lookup，TOCTOU 窗口消除）；IPv6 hex/NAT64 形态加固
- 恒时比较、空 token 拒绝、限流键 TTL 原子化 + clientKey 哈希（明文凭证不入键名）、AttemptLimiter 容量上限
- registry.invoke 补确认票（封网页注入旁路确认的门）；compose mnemosyne/Grafana 只绑回环，公网入口收敛到 Caddy

### 已知未实现（接口位已留，见 docs/status.md 诚实清单）

SCOUT 工具 schema 检索（§5.2.2）· 语义缓存（前置条件：narrativeVersion 稳定化）· OTel → Collector · Skill Forge（§22，攒 AgentTrace 中）· Dashboard 的 observatory / forge / settings 页 · Broker 短票动态取件启用

---

设计文档：[`docs/Mnemosyne_Technical_Implementation_Document_v0.3.0_complete.md`](docs/Mnemosyne_Technical_Implementation_Document_v0.3.0_complete.md) + [`v0.3.1_patch`](docs/Mnemosyne_Technical_Implementation_Document_v0.3.1_patch.md)。
