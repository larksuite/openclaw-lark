# Changelog

All notable changes to this project are documented in this file.

## 2026.10.6 — 2026-10-15（README 精简 + 版本表述修正）

**变更：**

- README（中英双语）精简：第二章「兼容版本」压缩为一行声明（仅列 OpenClaw 平台版本 8.1/8.35/9.6/9.7/9.8/10.3，移除误插入的插件版本行——OpenClaw 平台未发布 10.4/10.5）；第六章「版本历史」改为引导访问 GitHub Releases（每个版本更新详情在 Releases body 写清）
- 修正第一章对齐验证表述（10.3/10.4 → 10.3，OpenClaw 平台版本）与 contracts 告警消除版本（10.4 → 10.5）
- `package.json`：版本号 `2026.10.5` → `2026.10.6`，`build.openclawVersion` 同步

**影响：** 纯文档/版本号改动，插件运行时功能、兼容性、配置全部不变。

**发布形态：**

- 权威 tgz：`hotwvpyym-openclaw-lark-2026.10.6.tgz`
- 三渠道同源发布：npm `@hotwvpyym/openclaw-lark@2026.10.6`（latest）/ GitHub Release `v2026.10.6` / ClawHub 2026.10.6
- 兼容范围不变：OpenClaw `>=2026.8.1`

## 2026.10.5 — 2026-10-15（元数据规范化终版：移除 contracts 字段，ClawHub 扫描归零）

**为什么 10.3 → 10.4 → 10.5 间隔这么短：**

- 10.3 发布后，ClawHub **提交后安全扫描**（比本地 `clawhub package validate` 严格）检出 `manifest-unknown-contracts`（P1）：`contracts.tools` 声明的 key 不在平台契约白名单
- 10.4（同日）将 `contracts.tools` 39 个官方 7.16 遗留 key 对齐为官方内置 @openclaw/feishu@2026.10.3 的 14 个能力域级 key——**发布后平台扫描仍报同一告警**。实证结论：官方内置插件的工具名（feishu_*）同样不在 ClawHub 契约白名单（官方内置插件不经过 ClawHub 扫描注册，其工具名不会进入平台注册表）
- 10.5（本版）按平台指引（"Remove unsupported contract keys or move them to a documented OpenClaw contract field"）**直接移除 `contracts` 字段**，扫描告警归零

**变更：**

- `openclaw.plugin.json`：删除整个 `contracts` 字段（顶层 keys 变为 id/name/channels/skills/configSchema/channelConfigs 六个）
- `package.json`：版本号 `2026.10.4` → `2026.10.5`，`build.openclawVersion` 同步
- README（中英双语）与 CHANGELOG 同步更新

**影响说明（重要）：**

- `contracts` 是**静态能力所有权元数据**，仅用于 tool discovery 优化（让 OpenClaw 按需加载拥有目标工具的插件运行时），**不参与插件运行时逻辑**
- 官方文档明确：工具没有 `toolMetadata`/`contracts` 声明时，OpenClaw 保留既有行为——tool contract 匹配 policy 时正常加载拥有插件
- **插件运行时功能、39 个飞书工具、OpenClaw 8.1–10.3 兼容性（command-auth-compat 双路径）、footer/configSchema 41 字段、授权一致性 3840 组——全部不变**
- ClawHub 平台扫描预期 **0 errors / 0 warnings**
- 三渠道同源重新发布：npm `@hotwvpyym/openclaw-lark@2026.10.5` / GitHub Release `v2026.10.5` / ClawHub `@hotwvpyym/openclaw-lark` 2026.10.5

**发布形态：**

- 权威 tgz：`hotwvpyym-openclaw-lark-2026.10.5.tgz`
- 兼容范围不变：OpenClaw `>=2026.8.1`（8.1 / 8.35 / 9.6 / 9.7 / 9.8 / 10.3 实证）

## 2026.10.4 — 2026-10-15（元数据规范化第一步：contracts 对齐官方内置命名）

**为什么距 10.3 仅一天就发布 10.4：**

- 10.3 发布后，ClawHub **提交后安全扫描**（比本地 `clawhub package validate` 更严格，本地已 PASS）检出 `manifest-unknown-contracts`（P1）：manifest `contracts.tools` 声明的 39 个 contract keys 与平台契约白名单不一致
- 这 39 个 key 源自官方 @larksuite/openclaw-lark **2026.7.16 的遗留命名**（npm 包实测：官方 7.16 同样声明这 39 个 key）；官方内置 @openclaw/feishu@2026.10.3 已迁移为 **14 个能力域级 key**（`feishu_app_scopes` / `feishu_bitable_*` / `feishu_chat` / `feishu_doc` / `feishu_drive` / `feishu_perm` / `feishu_wiki`），交集仅 `feishu_chat` 一个

**变更：**

- `openclaw.plugin.json` 的 `contracts.tools`：39 个工具级 key → 官方内置 **14 个能力域级 key**（与 @openclaw/feishu@2026.10.3 完全一致）
- `package.json` 版本号：`2026.10.3` → `2026.10.4`
- README（中英双语）与 CHANGELOG 同步：版本历史、兼容表、安装命令更新为 2026.10.4

**影响说明（重要）：**

- 这是**纯元数据规范化**：`contracts` 是静态能力所有权元数据，不参与插件运行时
- **插件运行时功能、39 个飞书工具、OpenClaw 8.1–10.3 兼容性（command-auth-compat 双路径）、footer/configSchema 41 字段、授权一致性 3840 组——全部不变**
- ClawHub 平台扫描预期 **warning 归零**（0 errors / 0 warnings）
- 三渠道同源重新发布：npm `@hotwvpyym/openclaw-lark@2026.10.4` / GitHub Release `v2026.10.4` / ClawHub `@hotwvpyym/openclaw-lark` 2026.10.4

**发布形态：**

- 权威 tgz：`hotwvpyym-openclaw-lark-2026.10.4.tgz`
- 兼容范围不变：OpenClaw `>=2026.8.1`（8.1 / 8.35 / 9.6 / 9.7 / 9.8 / 10.3 实证）

## 2026.10.3 — 2026-10-14（对齐 OpenClaw 2026.10.3 稳定版）

**OpenClaw 10.x 兼容适配（核心变更）：**

- 适配 **OpenClaw 2026.10.3 稳定版**（npm latest，2026-10-13 发布）；SDK 依赖升级 `2026.10.2 → 2026.10.3`
- **新增 `command-auth-compat` 双路径兼容层**：OpenClaw 10.x 官方移除了 `openclaw/plugin-sdk/command-auth` 子路径（官方 7.16 静态 import 会在插件注册前加载失败）——9.x 走官方 legacy `command-auth`、10.x 自动切换官方 `channel-ingress-runtime`，覆盖 `2026.8.1` 至 `2026.10.3` 全线
- **授权一致性回归（对标官方 PR #638 方法论）**：3840 组参数对比 legacy vs ingress —— 3560 组一致（92.7%）；280 组差异全部为官方 10.x 语义收紧（更严格，无反向风险）；**修复空 sender + 通配 allowlist 越权缺口**（新增空 sender 恒拒绝保护）
- `openclaw.plugin.json` 补充 `name: "OpenClaw Lark (Community Compat)"`，消除 `manifest-name-missing` 警告
- **修复 manifest configSchema 空声明缺陷**：插件完整配置体系（41 个字段：footer/dmPolicy/replyMode/heartbeat/dedup/accounts 等，源自源码 `FEISHU_CONFIG_JSON_SCHEMA`）此前未同步到 manifest，导致 openclaw config validate 拒绝 `channels.feishu.footer` 等合法配置（报 `must not have additional properties`）。现已将源码自动生成的 JSON Schema 写入 manifest configSchema，页脚六项开关等配置可正常通过校验并生效
- ClawHub validate `2026.10.3`：**0 Breakages / 0 Warnings / PASS**
- 门禁全绿：typecheck 0 错误 / lint 0 errors / **54 文件 445 测试全绿** / build 通过
- 兼容范围：OpenClaw `>=2026.8.1`（8.1 / 8.35 / 9.6 / 9.7 / 9.8 / 10.3 实证）

**发布形态：**

- 权威 tgz：`hotwvpyym-openclaw-lark-2026.10.3.tgz`（sha256 `a22b3cda78bff3cf33ea0eea24e3af3f664c3e369e9f25b248db576672cf14fc`，含中英文 README）
- 三渠道同源发布：npm `@hotwvpyym/openclaw-lark` / GitHub Release `v2026.10.3` / ClawHub `@hotwvpyym/openclaw-lark`

## 2026.9.7 — 2026-10-04（正式发布版）

**发布就绪变更：**

- 包名改为 `@hotwvpyym/openclaw-lark`（npm scope 匹配 ClawHub 发布者，符合 ClawHub 发布规则）
- `openclaw.plugin.json` 的 `install.npmSpec` 同步更新
- 补充 `license: "MIT"` 字段（与 LICENSE 文件一致）
- 补充 `openclaw.build.openclawVersion: "2026.9.7"`（ClawHub 发布前置字段）
- README 全面改写：非官方声明、问题说明、兼容矩阵、安装使用、风险免责、反馈通道

**功能内容与 2026.9.6.11 一致：**

- 修复：卡片页脚 `tokens/cache/context/model` 指标在 OpenClaw 2026.9.7+ 丢失（agent 归属解析兜底）
- 修复：日历等 13 个文件 20 处 `page_size` 上下限按飞书官方文档全量补齐，calendar 系列增加运行时钳制（双保险）
- 优化：会话快照探测削峰（720 → ≤60 次/轮）、高频日志降噪、AbortController 生命周期管理
- 兼容：OpenClaw 2026.8.1 及以上全线（8.1 / 8.35 / 9.6 / 9.7 / 9.8 实证）

---

## 2026.9.6.11

- 修复：日历等 13 文件 20 处 `page_size` 上下限全量补齐（按飞书开放平台文档：calendar.list `[50,1000]`、event.search `[1,100]`、event.attendee `[10,100]`、task-v2 全系 `[1,100]`、wiki `[1,50]` 等）
- 修复：calendar 系列 execute 增加运行时钳制（`Math.min(max, Math.max(min, ps))` 防御模型违规）
- 清理上一版本批量注入产生的语法问题

## 2026.9.6.10

- 新增：流式卡片请求 AbortController 生命周期管理（可中断、随网关关闭清理）
- 优化：`not available` 日志降级 debug

## 2026.9.6.9

- 优化：会话快照探测削峰（SDK 探测一次缓存，每轮主组合 720 次 → ≤60 次）
- 优化：4 处高频日志 info → debug

## 2026.9.6.8

- **核心修复**：卡片页脚 `tokens / cache / context / model` 指标恢复显示
  - 根因：OpenClaw 2026.9.7 起会话存储改为 per-agent SQLite，agent 归属解析抛出 `AgentSelectionRequiredError` 被外层 catch 吞掉
  - 修复：`streaming-card-controller.ts` 与 `tool-use-config.ts` 两处 try/catch 兜底回退

## 2026.9.6.x（前序适配）

- 插件加载 / 飞书频道启动 / 收发消息适配 OpenClaw 9.6/9.7（对齐官方 9.6 基线）
