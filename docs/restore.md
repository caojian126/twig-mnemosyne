# 恢复手册（restore.md）— §13.6

> 备份未验证等于没有备份。本手册常备，**每季度做一次恢复演练**（演练记录追加在文末）。
> 两条备份路线的产物不同，按实际拿到的文件选路线：
> - **VPS 版 backup.sh**：`.sql.gz`（plain SQL）+ `.tar.gz` 卷快照 → 路线 A；
> - **Zeabur/本地版 backup-local.mjs**：`.dump`（pg_dump custom）+ `twig/<时间戳>/` JSON 快照 → 路线 B。

## 前置

新机：Ubuntu 24.04 LTS，已装 Docker + restic，`/opt/mnemosyne` 放置本仓库（compose + configs）。
`.env` 从密码管理器恢复（或从加密保管渠道取回）。

## 路线 A：VPS backup.sh 产物（.sql.gz + 卷 tar）

1. **起基础栈（先不起 mnemosyne/twig）**

   ```bash
   cd /opt/mnemosyne
   docker compose up -d postgres redis
   ```

2. **还原 Postgres**

   ```bash
   # 容器名随 compose 项目名走（twig-mnemosyne-*），用 compose exec 而非写死容器名
   gunzip -c /backup/pg/<date>.sql.gz \
     | docker compose exec -T postgres psql -U mnemosyne -d mnemosyne
   ```

3. **还原 twig 数据卷**

   ```bash
   docker volume create twig-mnemosyne_twig_data
   docker run --rm \
     -v twig-mnemosyne_twig_data:/data \
     -v /backup/twig:/backup:ro \
     alpine sh -c "cd /data && tar xzf /backup/<date>.tar.gz"
   ```

4. **起全栈**

   ```bash
   docker compose up -d
   ```

## 路线 B：backup-local.mjs 产物（.dump + JSON 快照）

1. **起基础栈**

   ```bash
   docker compose up -d postgres redis twig-memory litellm mcp-gateway
   ```

2. **还原 Postgres（custom 格式必须用 pg_restore，psql 灌不进去）**

   ```bash
   # 校验和先过一遍（backup-local 每轮产出 manifests/SHA256SUMS.*.txt）
   (cd /backup && sha256sum -c manifests/SHA256SUMS.<stamp>.txt)

   docker compose exec -T postgres pg_restore \
     --no-owner --no-privileges --clean --if-exists \
     -U mnemosyne -d mnemosyne \
     < /backup/pg/<stamp>.dump
   ```

3. **还原 twig 叙事快照（JSON → 引擎）**

   `twig/<stamp>/` 下的 JSON 与上游 export 端点同形状。单用户日常规模的数据量建议：
   - 起全栈后先对账：`GET /v1/web/memory/state` 与备份 state.json diff，确认缺口范围；
   - 记忆重灌走 Runtime 的搬家 CLI（§23 relocate，JSON → ingest/contest 重放路径已实现）；
   - 情感层（journal/soliloquy/notes）是 append-only 用户文本，按备份 JSON 逐条重放对应
     上游端点即可；碎片/认识层由历史会话（conversation_messages 已随 pg_dump 回来）经
     重新 ingest + reflect 重建。

4. **起全栈**

   ```bash
   docker compose up -d
   ```

## 健康验收（两条路线共用，全绿才算恢复成功）

```bash
curl -fsS http://127.0.0.1:8000/health | jq
# 期望：db / redis / twig 全部 ok，twig.auth === true
```

抽查一轮对话连续性：任选一个 client_key 发起 `/v1/chat/completions`，确认：

- 近期对话被正确带出（session 记录在）；
- `GET /v1/context` 的 promptText 与备份前叙事状态一致（threads/claims 齐全）；
- 缓存层允许 MISS（Redis 未备份属预期）。

## 已知取舍

- Redis 有意不备份：缓存可再生，恢复后首轮 MISS 是正常现象。
- 备份中的用户数据残留随 30 天保留期滚动出清（隐私政策如实声明，§8.6）。
- restic 仓库本身加密（BACKUP_RESTIC_PASSWORD），密码丢失 = 备份不可用，密码入密码管理器。
- backup-local.mjs 的 SHA256SUMS 只验完整性不验真实性——校验和匹配 ≠ 备份来自健康库，
  与 pg_restore --list 冒烟、季度恢复演练合起来才算闭环。

## 演练记录

| 日期 | 路线 | 结果 | 备注 |
|---|---|---|---|
| （待填） | | | |
