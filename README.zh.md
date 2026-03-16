# OpenClaw  Lark/飞书 插件

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/@larksuite/openclaw-lark.svg)](https://www.npmjs.com/package/@larksuite/openclaw-lark)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22-blue.svg)](https://nodejs.org/)

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
- **🔔 多维表格记录变更通知**：订阅指定多维表格的记录变更事件，自动将变更内容转发给 Agent

## 安全与风险提示（使用前必读）

**核心风险：** 这个插件通过 Lark/飞书接口连接了你的工作数据——消息、文档、日历、联系人，AI 能读到的东西理论上就有泄露的可能。虽然我们做了安全防护，但 AI 系统本身还不够成熟稳定，不能保证万无一失。

**强烈建议：** 

- 现阶段优先使用个人账号进行体验和测试。
- 相关 Lark/飞书应用推荐个人使用，不建议开放给多人使用。
- 建议避免在群聊中使用，降低你的数据泄露风险。

**其他操作风险**
- AI 并不完美，可能存在"幻觉"：它有时会误解您的意图，或者生成看似合理但不准确的内容。
- 部分操作不可逆转：例如，AI 代发的 Lark/飞书消息是以您的名义发出的，发出后即成事实。
- **应对建议：** 对于涉及发送、修改、写入等重要操作，请务必做到**"先预览，再确认"**，切勿让 AI 处于完全脱离人工干预的"全自动驾驶"状态。
- 作为机器人供多人使用或者通过公司飞书账号使用可能会导致数据安全和隐私风险，请注意使用时需要遵守企业内的数据安全和隐私要求，避免发生数据泄露、权限突破、侵犯隐私等后果

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
[OpenClaw  Lark/飞书官方插件使用指南](https://bytedance.larkoffice.com/docx/MFK7dDFLFoVlOGxWCv5cTXKmnMh)

## 多维表格记录变更通知

插件支持订阅多维表格的记录变更事件（`drive.file.bitable_record_changed_v1`），当多维表格中有记录新增、编辑或删除时，自动将变更内容发送给 Agent 所在的指定会话。

### 前置准备

1. **开启事件订阅**：在飞书开放平台 [开发者后台](https://open.feishu.cn/) → 应用 → 事件与回调 → 事件配置，添加 **多维表记录变更** 事件（`drive.file.bitable_record_changed_v1`），订阅方式选择**长连接**。

2. **订阅具体文件**：需要调用飞书 Drive 订阅 API，对目标多维表文件发起订阅请求（`drive.file.subscribe`）。可通过 OpenClaw Agent 中的 `feishu_drive` 工具执行，或使用飞书 API 调试工具手动完成。

### 配置示例

在 `openclaw.json` 的飞书账号配置中添加 `bitableNotifications` 字段：

```json
{
  "channels": {
    "feishu": {
      "appId": "cli_xxxxxxxx",
      "appSecret": "xxxxxxxx",
      "bitableNotifications": [
        {
          "fileToken": "RyGZbWS8ia64cbsBsrAc0tzCnXy",
          "chatId": "oc_xxxxxxxxxxxxxxxxxxxxxxxx",
          "label": "需求跟踪表"
        },
        {
          "fileToken": "AbCdEfGhIjKlMnOpQrStUvWxYz1",
          "chatId": "oc_yyyyyyyyyyyyyyyyyyyyyyyy",
          "tableIds": ["tblABC123"],
          "label": "项目进度表（仅跟踪 Sprint 表）"
        }
      ]
    }
  }
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `fileToken` | ✅ | 多维表格的 App Token（URL 中 `base/` 后的部分） |
| `chatId` | ✅ | 接收通知的会话 ID（p2p 使用 `oc_xxx`，群聊同样使用 `oc_xxx`） |
| `tableIds` | ❌ | 只监听指定数据表，省略则监听该多维表下所有数据表 |
| `label` | ❌ | 通知消息中显示的可读名称，便于区分多个多维表 |

## 贡献

我们欢迎社区的贡献！如果你发现 Bug 或有功能建议，请随时提交 [Issue](https://github.com/larksuite/openclaw-larksuite/issues) 或 [Pull Request](https://github.com/larksuite/openclaw-larksuite/pulls)。

对于较大的改动，我们建议你先通过 Issue 与我们讨论。

## 许可证

本项目基于 **MIT 许可证**。详情请参阅 [LICENSE](./LICENSE.md) 文件。
