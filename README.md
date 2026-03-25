# OpenClaw Lark/Feishu Plugin

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/@larksuite/openclaw-lark.svg)](https://www.npmjs.com/package/@larksuite/openclaw-lark)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22-blue.svg)](https://nodejs.org/)

[中文版](./README.zh.md) | English

This is the official Lark/Feishu plugin for OpenClaw, developed and maintained by the Lark/Feishu Open Platform team. It seamlessly connects your OpenClaw Agent to your Lark/Feishu workspace, enabling it to directly read from and write to messages, docs, bases, calendars, tasks, and more.

## Features

This plugin provides comprehensive Lark/Feishu integration for OpenClaw, including:

| Category | Capabilities |
|------|------|
| 💬 Messenger | Read messages (group/DM history, thread replies), send messages, reply to messages, search messages, download images/files |
| 📄 Docs | Create, update, and read documents |
| 📊 Base | Create/manage bases, tables, fields, records (CRUD, batch operations, advanced filtering), views |
| 📈 Sheets | Create, edit, and view spreadsheets |
| 📅 Calendar | Manage calendars and events (create/query/update/delete/search), manage attendees, check free/busy status |
| ✅ Tasks | Manage tasks (create/query/update/complete), manage task lists, subtasks, and comments |

Additionally, the plugin supports:
- **📱 Interactive Cards**: Real-time status updates (Thinking/Generating/Complete), plus confirmation buttons for sensitive operations
- **🌊 Streaming Responses**: Live streaming text directly within message cards
- **🔒 Permission Policies**: Flexible access control policies for DMs and group chats
- **⚙️ Advanced Group Configuration**: Per-group settings including allowlists, skill bindings, and custom system prompts
- **🔔 Base Record Change Notifications**: Subscribe to record change events in specified bases and automatically forward changes to the Agent

## Security & Risk Warnings (Read Before Use)

This plugin integrates with OpenClaw AI automation capabilities and carries inherent risks such as model hallucinations, unpredictable execution, and prompt injection. After you authorize Lark/Feishu permissions, OpenClaw will act under your user identity within the authorized scope, which may lead to high-risk consequences such as leakage of sensitive data or unauthorized operations. Please use with caution.

To reduce these risks, the plugin enables default security protections at multiple layers. However, these risks still exist. We strongly recommend that you do not proactively modify any default security settings; once relevant restrictions are relaxed, the risks will increase significantly, and you will bear the consequences.

We recommend using the Lark/Feishu bot connected to OpenClaw as a private conversational assistant. Do not add it to group chats or allow other users to interact with it, to avoid abuse of permissions or data leakage.

Please fully understand all usage risks. By using this plugin, you are deemed to voluntarily assume all related responsibilities.


**Disclaimer:**

This software is licensed under the MIT License. When running, it calls Lark/Feishu Open Platform APIs. To use these APIs, you must comply with the following agreements and privacy policies:

- [Feishu Privacy Policy](https://www.feishu.cn/en/privacy?from=openclaw_plugin_readme)
- [Feishu User Terms of Service](https://www.feishu.cn/en/terms?from=openclaw_plugin_readme)
- [Feishu Store App Service Provider Security Management Specifications](https://open.larkoffice.com/document/uAjLw4CM/uMzNwEjLzcDMx4yM3ATM/management-practice/app-service-provider-security-management-specifications)

- [Lark Privacy Policy](https://www.larksuite.com/user-terms-of-service)
- [Lark User Terms of Service](https://www.larksuite.com/privacy-policy)

## Requirements & Installation

Before you start, make sure you have the following:

- **Node.js**: `v22` or higher.
- **OpenClaw**: OpenClaw is installed and works properly. For details, visit the [OpenClaw official website](https://openclaw.ai).

> **Note**: OpenClaw version must be **2026.2.26** or higher. Check with `openclaw -v`. If below this version, you may encounter issues. Upgrade with:
> ```bash
> npm install -g openclaw
> ```

## Usage Guide

[How to Use the Official Lark/Feishu Plugin for OpenClaw](https://bytedance.larkoffice.com/docx/MFK7dDFLFoVlOGxWCv5cTXKmnMh)

## Base Record Change Notifications

The plugin supports subscribing to Base record change events (`drive.file.bitable_record_changed_v1`). When records are added, edited, or deleted in a Base table, the plugin automatically forwards the change details to the Agent in a specified Feishu chat.

### Prerequisites

1. **Enable the event subscription**: In the [Feishu Developer Console](https://open.feishu.cn/) → Your App → Events & Callbacks → Event Configuration, add the **Base Record Changed** event (`drive.file.bitable_record_changed_v1`) and set the subscription method to **Persistent Connection (长连接)**.

2. **Subscribe to the specific file**: Call the Feishu Drive subscribe API (`drive.file.subscribe`) for the target Base file. You can do this via the `feishu_drive` tool in OpenClaw Agent or using the Feishu API Explorer manually.

### Configuration

Add `bitableNotifications` to your Feishu account config in `openclaw.json`:

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
          "label": "Requirements Tracker"
        },
        {
          "fileToken": "AbCdEfGhIjKlMnOpQrStUvWxYz1",
          "chatId": "oc_yyyyyyyyyyyyyyyyyyyyyyyy",
          "tableIds": ["tblABC123"],
          "label": "Project Progress (Sprint table only)"
        }
      ]
    }
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `fileToken` | ✅ | The Base app token (the part after `base/` in the URL) |
| `chatId` | ✅ | Target Feishu chat ID to receive notifications (`oc_xxx` for both DMs and group chats) |
| `tableIds` | ❌ | Only listen to specific table IDs; omit to monitor all tables in the Base |
| `label` | ❌ | Human-readable name shown in the notification message to help distinguish multiple bases |

## Contributing

Community contributions are welcome! If you find a bug or have feature suggestions, please submit an [Issue](https://github.com/larksuite/openclaw-larksuite/issues) or a [Pull Request](https://github.com/larksuite/openclaw-larksuite/pulls).

For major changes, we recommend discussing with us first via an Issue.

## License

This project is licensed under the **MIT License**. See [LICENSE](./LICENSE.md) for details.
