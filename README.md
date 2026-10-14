# OpenClaw Lark/Feishu Plugin — Community Compatibility Build（社区兼容版）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22-blue.svg)](https://nodejs.org/)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-%3E%3D2026.8.1-blue.svg)](https://openclaw.ai)

> **⚠️ 非官方版本声明 / NOT the official release**
>
> 本仓库是**社区维护的兼容适配版（Community Compatibility Build）**，基于飞书官方 `openclaw-lark` 插件源码（MIT 许可）二次开发，**并非飞书（Lark/Feishu）官方出品，也不享受任何官方支持**。
>
> 官方插件已于 **2026.7.16** 停止更新，无法在 OpenClaw 2026.9.x 及以上版本正常工作。本版本解决该问题，供社区自用与分享。
>
> *English: This is a community-maintained fork of the official Lark/Feishu plugin for OpenClaw (MIT licensed). It is NOT an official release and receives NO official support. The official plugin stopped at 2026.7.16 and is incompatible with OpenClaw 2026.9.x+; this build restores full functionality.*

---

## 一、这个插件解决什么问题（What this build fixes）

### 背景

| 事实 | 说明 |
|---|---|
| 官方插件停更 | `larksuite/openclaw-lark` 最后一个官方版本为 **2026.7.16**，之后官方不再维护 |
| 与新版 OpenClaw 不兼容 | 官方 2026.7.16 版无法安装/正常运行在 OpenClaw **2026.9.x 及以上**（插件 SDK API 已变化）；**2026.10.x 起官方移除了 `openclaw/plugin-sdk/command-auth` 子路径**，官方 7.16 的静态 import 会在插件注册前加载失败 |
| 官方新线门槛更高 | 官方替代插件 `@openclaw/feishu` 要求 OpenClaw **≥2026.9.8**，无法用于 9.7 及以下版本，且该插件**不提供卡片用量页脚（footer metrics）** |

### 本版本修复的核心问题（OpenClaw 2026.9.7 生产实测验证 + 2026.10.3 对齐验证）

1. **卡片页脚指标缺失**：官方版升级到 9.7 后，卡片页脚只剩「状态 + 耗时」，`tokens / cache / context / model` 四项全部丢失。
   - 根因：OpenClaw 2026.9.7 起会话存储从 `sessions.json` 改为 **per-agent SQLite**（`<stateDir>/agents/<agentId>/agent/openclaw-agent.sqlite`），footer 渲染时的 agent 归属解析抛出 `AgentSelectionRequiredError`，被外层 `catch` 静默吞掉，导致页脚渲染中止。
   - 修复：在 `streaming-card-controller.ts` 与 `tool-use-config.ts` 两处增加 try/catch 兜底回退，指标完整恢复。
2. **日历等分页接口 400 报错**：`calendar.list`、`calendar.event.search`、`event.attendee.list` 等接口的 `page_size` schema 缺少 `minimum` 约束，传入小于下限的值（如 10）直接 400 `field validation failed`。
   - 修复：全量核对飞书开放平台文档，为 **13 个文件 20 处** `page_size` 补齐 `minimum/maximum`（如 calendar.list `[50,1000]`、event.search `[1,100]`、event.attendee `[10,100]`、task-v2 全系 `[1,100]`），并对 calendar 系列增加运行时钳制（双保险）。
3. **性能与稳定性优化**：
   - 会话快照探测削峰（每轮 720 次 → ≤60 次，SDK 探测一次缓存）；
   - 高频日志降噪（info → debug）；
   - AbortController 生命周期管理（流式卡片请求可被中断、随网关关闭清理）。
4. **OpenClaw 10.x 兼容层（2026.10.3 起）**：官方 10.x 移除了 `openclaw/plugin-sdk/command-auth` 子路径，新增 `command-auth-compat` 双路径兼容层：
   - **9.x**（`2026.8.1` ~ `2026.9.x`）：仍走官方 legacy `command-auth`，行为与历史版本完全一致；
   - **10.x**（`2026.10.x`）：自动切换到官方 `channel-ingress-runtime` 完成命令授权（与 OpenClaw 10.x 主机其他渠道行为一致）；
   - **授权一致性回归**：3840 组参数对比 legacy vs ingress，3560 组一致（92.7%），280 组差异全部为官方 10.x 有意收紧（更严格、更安全，无反向风险）；同时修复空 sender + 通配 allowlist 的越权缺口（详见 `reports/auth-consistency/REPORT.md`）。
5. **manifest configSchema 修复（OpenClaw 10.x 配置校验收严）**：OpenClaw 10.x 起基于插件 manifest 的 `configSchema` **严格校验**渠道配置；旧版 manifest 该字段为空，导致 `channels.feishu.footer`（页脚六项开关）等全部合法配置被拒绝（报 `must not have additional properties`），openclaw 升级后插件配置直接 invalid。
   - 修复：将源码 `FEISHU_CONFIG_JSON_SCHEMA`（zod 自动生成）完整同步进 manifest `configSchema`，共 **41 个字段**（footer 六项 / dmPolicy / replyMode / heartbeat / dedup / accounts 等）；
   - 效果：`openclaw config validate` 通过，页脚六项等配置正常生效；本地 clawhub validate **0 Breakages / 0 Warnings**（平台提交后扫描的 contracts 告警已在 2026.10.5 规范化消除）。

### 保留的官方全部功能

本版本**完整保留官方插件全部功能**（40+ 飞书工具族），未删减任何能力：

| 类别 | 能力 |
|---|---|
| 💬 消息 | 读取消息（群聊/私聊历史、线程回复）、发送消息、回复消息、搜索消息、下载图片/文件 |
| 📄 文档 | 创建、更新、读取文档 |
| 📊 多维表格 Base | 管理 Base/数据表/字段/记录（增删改查、批量、高级筛选）、视图 |
| 📈 电子表格 | 创建、编辑、查看表格 |
| 📅 日历 | 管理日历与日程（增删改查、搜索）、参与人管理、忙闲查询 |
| ✅ 任务 | 任务（增删改查、完成）、任务清单、子任务、评论 |
| 📁 云盘/维基 | 云盘文件、知识库空间与节点 |
| 🔍 搜索 | 文档/消息搜索 |
| 🎴 交互卡片 | 实时状态更新（思考/生成/完成）+ 敏感操作确认按钮 |
| 🌊 流式输出 | 卡片内实时流式文本（私聊为流式、群聊为静态，设计如此） |
| 📊 卡片页脚六项 | 状态、耗时、Token 使用量、缓存命中、上下文占用、模型（全部可独立开关） |
| 🔒 权限策略 | 私聊/群聊灵活访问控制 |
| ⚙️ 群组高级配置 | 白名单、Skill 绑定、自定义系统提示词 |

---

## 二、兼容版本（Compatibility）

兼容 OpenClaw **2026.8.1 及以上所有稳定版**（当前最新验证版本：2026.10.3；仅维护稳定版，beta 不在支持范围）。

已实测：`2026.8.1 / 2026.8.35 / 2026.9.6 / 2026.9.7（生产实测）/ 2026.9.8 / 2026.10.3`——typecheck 全 0 错误，9.7 另经生产服务器全功能实测（footer 六项/消息收发/插件加载全过）。

架构说明：OpenClaw 8.x / 9.6 使用 `sessions.json` 会话存储，9.7+ 使用 per-agent SQLite——插件对两种架构均兼容（SQLite 直读不可用时自动回退 SDK 读取）。

---

## 三、安装与使用（Installation & Usage）

### 前置要求

- **Node.js**：v22 或更高
- **OpenClaw**：2026.8.1 或更高（`openclaw -v` 查看）

### 安装方式

**方式 A：本地 tgz 安装（推荐，最可控）**

```bash
openclaw plugins install npm-pack:/path/to/hotwvpyym-openclaw-lark-2026.10.6.tgz --force --accept-capabilities
```

**方式 B：从 GitHub Release 下载**

在 [Releases](../../releases) 页面下载 `hotwvpyym-openclaw-lark-2026.10.6.tgz`，然后按方式 A 安装。

**方式 C：ClawHub（发布后可用）**

```bash
openclaw plugins install @hotwvpyym/openclaw-lark
```

安装完成后确认：

```bash
openclaw plugins list        # 应看到 openclaw-lark，版本 2026.10.6
openclaw gateway restart     # 若安装过程提示 drain 超时，用此命令兜底
```

### 启用与配置

```bash
# 启用飞书渠道（WebSocket 长连接 + 流式输出）
openclaw config set channels.feishu.enabled true
openclaw config set channels.feishu.websocket true
openclaw config set channels.feishu.streaming true

# 卡片页脚六项指标（默认即可全部打开）
openclaw config set channels.feishu.footer.status true    # 状态
openclaw config set channels.feishu.footer.elapsed true   # 耗时
openclaw config set channels.feishu.footer.tokens true    # Token 使用量
openclaw config set channels.feishu.footer.cache true     # 缓存命中
openclaw config set channels.feishu.footer.context true   # 上下文占用
openclaw config set channels.feishu.footer.model true     # 模型
```

### 行为说明

- **私聊**：流式输出（文字在卡片内实时滚动）；
- **群聊**：静态卡片（设计如此，避免刷屏）；
- **页脚指标**：`tokens/cache/context/model` 在每次回复完成后随卡片展示；
- **敏感操作**（如删除、批量操作）：卡片弹出确认按钮，需人工确认后执行。

---

## 四、风险与免责声明（Risk & Disclaimer）

**请在使用前完整阅读本节。**

1. **非官方声明**：本插件是社区适配版，**与飞书（Lark/Feishu）官方无关**，官方不提供任何支持、不承担任何责任；请勿将本插件相关问题提交给官方渠道。
2. **按现状提供（AS-IS）**：本插件按「现状」提供，**不提供任何明示或默示担保**，包括但不限于适销性、特定用途适用性、不侵权的默示担保。使用产生的任何后果由使用者自行承担。
3. **AI 自动化固有风险**：插件对接 OpenClaw AI 自动化能力，存在模型幻觉、不可预测执行、提示词注入等固有风险。授权飞书权限后，OpenClaw 将在授权范围内以你的用户身份执行操作，可能造成敏感数据泄露或未授权操作等高风险后果。
4. **使用建议**：强烈建议仅将机器人作为**私聊助手**使用，不要加入公开群聊或允许陌生人交互，避免权限滥用与数据泄露；生产环境使用前请充分评估。
5. **第三方条款**：插件运行时调用飞书开放平台 API，使用即视为同意遵守：
   - [飞书隐私政策](https://www.feishu.cn/en/privacy)
   - [飞书用户服务协议](https://www.feishu.cn/en/terms)
   - [Lark Privacy Policy](https://www.larksuite.com/privacy-policy)
   - [Lark User Terms of Service](https://www.larksuite.com/user-terms-of-service)
6. **兼容性边界**：虽已对 2026.8.1+ 全线做兼容验证，但 OpenClaw 与飞书 API 持续演进，未来版本可能出现新的不兼容；升级 OpenClaw 前请先验证本插件。
7. **授权与许可**：本插件基于官方 MIT 源码改造，保留官方版权声明，MIT 许可允许修改与再分发（详见 [LICENSE](./LICENSE)）；请勿以本插件名义冒充官方版本。

---

## 五、反馈与更新（Feedback & Updates）

**欢迎任何问题反馈！**

- 🐛 **Bug 报告**：请提交 [Issue](../../issues)，附上：OpenClaw 版本（`openclaw -v`）、插件版本（`openclaw plugins list`）、复现步骤、相关日志。
- 💡 **功能建议**：同样通过 Issue 提出。
- 🔄 **持续更新**：本仓库将跟随 OpenClaw 版本演进持续维护。升级方式三选一：
  - **热更新（推荐，无需重启 Gateway）**：`openclaw plugins update <id>` 或 `openclaw plugins install <新版>` 后执行 `openclaw plugins reload <id>`——OpenClaw 10.x 原生支持插件级热重载（60 秒 drain 窗口，失败自动回滚保留旧版本继续服务）；本插件已通过资源生命周期审计，兼容 reload；
  - **本地 tgz**：`openclaw plugins install npm-pack:/path/to/<新版.tgz> --force --accept-capabilities`（同名升级直接覆盖）；
  - **兜底**：`openclaw gateway restart`。

**已知限制**：暂无已知功能性问题；如发现问题会在本 README 与 CHANGELOG 中同步更新。

---

## 六、版本历史（Changelog）

每个版本的详细更新说明（修复内容、发布原因、权威包 sha256）请查看 [GitHub Releases](https://github.com/hotwvpyym/openclaw-lark-compat/releases)。

当前版本：**2026.10.6**（兼容 OpenClaw 2026.8.1 – 10.3 stable；三渠道同源发布：npm / GitHub Release / ClawHub，包内容逐字节一致）。

---

## 七、许可证（License）

本项目基于 **MIT License** 分发，保留官方版权声明：

- Copyright (c) 2026 Lark Technologies Pte. Ltd.（官方原始版权）
- 本适配版在原作基础上修改，见 [LICENSE](./LICENSE) 全文。

---

## 致谢（Acknowledgements）

- [飞书官方 openclaw-lark 插件](https://github.com/larksuite/openclaw-lark)（MIT）—— 本仓库的源码基底
- OpenClaw 社区 —— 测试与反馈
