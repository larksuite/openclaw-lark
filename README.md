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

## Security & Risk Warnings (Read Before Use)

**Core risk:** This plugin connects to your work data via Lark/Feishu APIs—messages, docs, calendars, contacts. Anything the AI can read could theoretically be leaked. While we have implemented security protections, AI systems are not yet mature or stable enough to guarantee absolute safety.

**Strong recommendations:**
- Use a personal account for evaluation and testing at this stage.
- Use the related Lark/Feishu apps personally, and avoid deploying to large numbers of users.
- Avoid using it in group chats to reduce the risk of data exposure.
- Using this bot for multiple users and/or with a company Feishu account may introduce data security and privacy risks. Make sure you comply with your organization’s internal data security and privacy requirements to avoid data leakage, privilege escalation, privacy violations, or related consequences.

**Other operational risks**
- AI is not perfect and may hallucinate: It may sometimes misunderstand your intent or generate content that appears reasonable but is inaccurate.
- Some operations are irreversible: For example, messages sent by the AI on your behalf are sent in your name and cannot be undone once sent.
- **Mitigation advice:** For important operations involving sending, modifying, or writing data, always **preview first, then confirm**. Never allow the AI to operate in a fully autonomous mode without human oversight.

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

## Contributing

Community contributions are welcome! If you find a bug or have feature suggestions, please submit an [Issue](https://github.com/larksuite/openclaw-larksuite/issues) or a [Pull Request](https://github.com/larksuite/openclaw-larksuite/pulls).

For major changes, we recommend discussing with us first via an Issue.

## License

This project is licensed under the **MIT License**. See [LICENSE](./LICENSE.md) for details.
