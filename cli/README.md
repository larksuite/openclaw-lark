# Feishu CLI

Standalone CLI wrapper around the existing Feishu/Lark OpenClaw tools.

## Commands

```bash
node cli/run.mjs list
node cli/run.mjs describe feishu_calendar_event
node cli/run.mjs auth
node cli/run.mjs auth --scope "calendar:read calendar:write"
node cli/run.mjs feishu_calendar_event '{"action":"list","start_time":"2026-03-11T00:00:00+08:00","end_time":"2026-03-12T00:00:00+08:00"}'
```

## Config

Default config path: `~/.feishu-cli.json`

```json
{
  "appId": "cli_xxxxxx",
  "appSecret": "xxxxxxxxxxxxxxxx",
  "domain": "feishu",
  "userOpenId": "ou_xxxxxx",
  "chatId": "oc_xxxxxx",
  "mcpEndpoint": "https://mcp.feishu.cn/mcp"
}
```

Environment variables override file values:

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_DOMAIN`
- `FEISHU_USER_OPEN_ID`
- `FEISHU_CHAT_ID`
- `FEISHU_MCP_ENDPOINT`
- `FEISHU_MCP_BEARER_TOKEN`

## Auth behavior

When a tool hits user authorization, the CLI sends the existing auth card to
Feishu and blocks until the result is determinable. The caller should set a
timeout of at least `300000` ms to cover device-flow expiry.

## Runtime note

The source CLI is launched through `cli/run.mjs`, which bundles the local
TypeScript sources before execution. This avoids `tsx` runtime incompatibilities
with the current dependency graph.
