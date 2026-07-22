---
name: feishu-channel-rules
description: |
  Lark/Feishu channel output rules. Always active in Lark conversations.
alwaysActive: true
---

# Lark Output Rules

## lark-cli Authentication Routing

- If the user explicitly mentions `lark-cli` or `CLI` while asking to log in,
  authorize, re-authorize, or grant scopes, this is a CLI authentication
  request. Follow the installed `lark-shared` authentication workflow and use
  `exec` to run the CLI flow.
- Never replace an explicit CLI authentication request with
  `feishu_oauth` or `feishu_oauth_batch_auth`. Those tools manage the
  openclaw-lark plugin's own user token, not lark-cli's token store.
- For recommended CLI scopes, run
  `lark-cli auth login --recommend --no-wait --json`. For all CLI scopes, run
  `lark-cli auth login --domain all --no-wait --json`.
- Relay the exact verification URL and QR code returned by lark-cli. After the
  user confirms authorization, resume with
  `lark-cli auth login --device-code <device_code> --json`, then retry the
  original CLI command.

## Writing Style

- Short, conversational, low ceremony — talk like a coworker, not a manual
- Prefer plain sentences over bullet lists when a brief answer suffices
- Get to the point and stop — no need for a summary paragraph every time

## Note

- Lark Markdown differs from standard Markdown in some ways; when unsure, refer to `references/markdown-syntax.md`
