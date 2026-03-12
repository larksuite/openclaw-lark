---
name: feishu-cli
description: |
  Interact with Feishu/Lark APIs via the feishu-cli command-line tool. Use when: (1) managing calendars/meetings, creating/editing/fetching documents, managing tasks/tasklists, working with bitable (spreadsheets), sending messages, searching users, or any Feishu/Lark workspace operation, (2) user mentions Feishu, Lark, or 飞书, (3) user asks to schedule meetings, create docs, manage tasks, read messages, or interact with Feishu services. Requires feishu-cli installed and ~/.feishu-cli.json configured.
---

# feishu-cli

CLI wrapper for Feishu/Lark Open API. All output is JSON to stdout.

## Commands

```bash
# Discovery
feishu-cli list                              # List all tool names (JSON array)
feishu-cli describe <tool_name>              # Show tool schema (name, description, parameters)

# Tool invocation
feishu-cli <tool_name> '<json_params>'       # Invoke a tool

# Authorization
feishu-cli auth                              # Batch authorize all scopes
feishu-cli auth --scope "calendar:read"      # Authorize specific scope
```

## Workflow

1. **Discover**: Run `feishu-cli list` to see available tools
2. **Inspect**: Run `feishu-cli describe <tool>` to get the full parameter schema
3. **Invoke**: Run `feishu-cli <tool> '<json>'` to execute

Always run `describe` before first use of a tool to understand its parameters. Do not guess parameter names.

## Output Format

All responses are single-line JSON:

```jsonc
// Success
{"ok": true, "data": { ... }}

// Auth required (user-scope) — CLI blocks and waits automatically
{"ok": false, "auth_completed": true, "retryable": true, "message": "..."}
{"ok": false, "auth_failed": true, "message": "..."}

// Auth required (app-scope) — needs admin action, not retryable immediately
{"ok": false, "awaiting_app_authorization": true, "message": "..."}

// Error
{"ok": false, "error": "..."}
```

## Authorization Handling

Tools use user OAuth tokens. First invocation of a tool may trigger authorization.

### User-scope auth flow

When a tool needs user authorization, the CLI:
1. Sends an auth card to the user's Feishu chat (not terminal)
2. Blocks waiting for the user to complete auth (~4 min timeout)
3. Returns `auth_completed` or `auth_failed`

**Critical**: Set Bash timeout to 300000ms (5 minutes) for any command that might trigger auth:

```bash
# First-time tool call or auth command — always use 300s timeout
feishu-cli auth                              # timeout: 300000
feishu-cli feishu_calendar_event '{"action":"list","start_time":"...","end_time":"..."}'  # timeout: 300000
```

**On `auth_completed`**: Retry the same tool call immediately — it will succeed.

**On `auth_failed`**: Inform the user that authorization was not completed. Ask them to check Feishu for the auth card and try again.

### App-scope auth flow

When `awaiting_app_authorization` is returned, the app itself lacks permissions. Inform the user they need an admin to approve the app's scope in Feishu admin console. This is NOT retryable by re-running the command.

### When to use long timeout

Use `timeout: 300000` for:
- `feishu-cli auth` (always)
- First invocation of any tool for a user (auth may be needed)
- After `auth_failed` when retrying

Once a tool has succeeded for a user, subsequent calls to tools in the same scope will not need auth again — normal timeout is fine.

## Configuration

Requires `~/.feishu-cli.json`:

```json
{
  "appId": "cli_xxx",
  "appSecret": "xxx",
  "domain": "feishu",
  "userOpenId": "ou_xxx",
  "chatId": "oc_xxx"
}
```

- `appId` / `appSecret`: Feishu app credentials (required)
- `domain`: `"feishu"` or `"lark"` (default: `"feishu"`)
- `userOpenId`: Current user's open_id (required for tool invocation)
- `chatId`: Chat ID for auth card delivery (required for tool invocation)

If config is missing, guide the user to create it. `userOpenId` can be found via Feishu admin or by asking the user.

## Tool Categories

| Category | Tools | Use for |
|----------|-------|---------|
| Calendar | `feishu_calendar_*` | Meetings, events, freebusy |
| Task | `feishu_task_*` | Tasks, tasklists, subtasks, comments |
| Document | `feishu_create_doc`, `feishu_update_doc`, `feishu_fetch_doc` | Cloud docs (Lark Markdown) |
| Document utils | `feishu_doc_comments`, `feishu_doc_media`, `feishu_search_doc_wiki` | Comments, media, search |
| Bitable | `feishu_bitable_*` | Spreadsheets, records, fields, views |
| Drive | `feishu_drive_file` | File management |
| Wiki | `feishu_wiki_*` | Knowledge base spaces and nodes |
| Sheet | `feishu_sheet` | Spreadsheet operations |
| IM | `feishu_im_*`, `feishu_chat*` | Messages, chat management |
| User | `feishu_get_user`, `feishu_search_user` | User lookup |

For domain-specific business rules and constraints beyond what the schema shows, see [references/tool-knowledge.md](references/tool-knowledge.md).
