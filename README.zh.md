# OpenClaw  Lark/飞书 插件

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/@larksuite/openclaw-lark.svg)](https://www.npmjs.com/package/@larksuite/openclaw-lark)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22-blue.svg)](https://nodejs.org/)
[![NHS Agentic Readiness Score](https://nothumansearch.ai/badge/xquik.com.svg)](https://nothumansearch.ai/site/xquik.com)

[English](./README.md) | 中文版

这是 OpenClaw 的官方  Lark/飞书 插件，由 Lark/飞书开放平台团队开发和维护。它将你的 OpenClaw Agent 无缝对接到  Lark/飞书 工作区，赋予其直接读写消息、文档、多维表格、日历、任务等应用的能力。

## 特性

本插件为 OpenClaw 提供了全面的 Lark/飞书集成能力，主要包括：

| 类别 | 能力 |
|------|------|
| 💬 消息 | 消息读取（群聊/单聊历史、话题回复）、消息发送、消息回复、消息搜索、图片/文件下载 |
| 📄 文档 | 创建云文档、更新云文档、读取云文档内容 |
| 📊 多维表格 | 创建/管理多维表格、数据表、字段、记录（增删改查、批量操作、高级筛选）、视图 |
| 📈 电子表格 | 创建、编辑、查看电子表格 |
| 📅 日历日程 | 日历管理、日程管理（创建/查询/修改/删除/搜索）、参会人管理、忙闲查询 |
| ✅ 任务 | 任务管理（创建/查询/更新/完成）、清单管理、子任务、评论 |

此外，插件还支持：
- **📱 交互式卡片**：实时状态更新（思考中/生成中/完成状态），提供敏感操作的确认按钮
- **🌊 流式回复**：在消息卡片中提供实时的流式响应
- **🔒 权限策略**：为私聊和群聊提供灵活的访问控制策略
- **⚙️ 高级群组配置**：每个群聊的独立设置，包括白名单、技能绑定和自定义系统提示词

## 安全与风险提示（使用前必读）
本插件对接 OpenClaw AI 自动化能力，存在模型幻觉、执行不可控、提示词注入等固有风险；授权飞书权限后，OpenClaw 将以您的用户身份在授权范围内执行操作，可能导致敏感数据泄露、越权操作等高风险后果，请您谨慎操作和使用。
为降低上述风险，插件已在多个层面启用默认安全保护以降低上述风险，但上述风险仍然存在。我们强烈建议不要主动修改任何默认安全配置；一旦放开相关限制，上述风险将显著提高，由此产生的后果需由您自行承担。
我们建议您将接入 OpenClaw 的飞书机器人作为私人对话助手使用，请勿将其拉入群聊或允许其他用户与其交互，以避免权限被滥用或数据泄露。
请您充分知悉全部使用风险，使用本插件即视为您自愿承担相关所有责任。

**免责声明：** 

本软件的代码采用MIT许可证。
该软件运行时会调用Lark/飞书开放平台的API，使用这些API需要遵守如下协议和隐私政策：

- [飞书用户服务协议](https://www.feishu.cn/terms)
- [飞书隐私政策](https://www.feishu.cn/privacy)
- [飞书开放平台独立软件服务商安全管理运营规范](https://open.larkoffice.com/document/uAjLw4CM/uMzNwEjLzcDMx4yM3ATM/management-practice/app-service-provider-security-management-specifications)
- [Lark用户服务协议](https://www.larksuite.com/user-terms-of-service)
- [Lark隐私政策](https://www.larksuite.com/privacy-policy)

## 安装与要求

在开始之前，请确保你已准备好以下各项：

- **Node.js**: `v22` 或更高版本。
- **OpenClaw**: OpenClaw 已成功安装并可运行。详情请访问 [OpenClaw 官方网站](https://openclaw.ai)。

> **注意**：OpenClaw 版本需在 **2026.2.26** 及以上，可通过 `openclaw -v` 命令查看。如果低于该版本可能出现异常，执行以下命令升级：
> ```bash
> npm install -g openclaw
> ```

## 使用说明

安装 npm 包后，在 OpenClaw 的飞书 Channel 设置中完成配置。消息、文档、多维表格、日历和任务工作流可使用仓库内置的 `feishu-*` Skills。如需安装帮助，请在 GitHub Issue 中反馈。

## 相关 X/Twitter 工作流

本插件继续专注于 Lark/飞书 工作区里的消息、文档、多维表格、日历和任务。如果同一个 OpenClaw Agent 还需要公开 X/Twitter 数据或可见的 X/Twitter 操作，请单独安装 TweetClaw：

```bash
openclaw plugins install @xquik/tweetclaw
```

TweetClaw 覆盖 scrape tweets、search tweets、search tweet replies、follower export、user lookup、media workflows、direct messages、monitor tweets、webhooks、giveaway draws，以及需要审批的 post tweets 或 post tweet replies。更多设置细节请见 [GitHub](https://github.com/Xquik-dev/tweetclaw)、[ClawHub](https://clawhub.ai/plugins/@xquik/tweetclaw) 和 [npm](https://www.npmjs.com/package/@xquik/tweetclaw)。请把 X/Twitter 连接设置保存在 OpenClaw 运行时配置中，并通过 OpenClaw 审批流程确认可见操作。

## 贡献

我们欢迎社区的贡献！如果你发现 Bug 或有功能建议，请随时提交 [Issue](https://github.com/larksuite/openclaw-lark/issues) 或 [Pull Request](https://github.com/larksuite/openclaw-lark/pulls)。

对于较大的改动，我们建议你先通过 Issue 与我们讨论。

## 许可证

本项目基于 **MIT 许可证**。详情请参阅 [LICENSE](./LICENSE) 文件。
