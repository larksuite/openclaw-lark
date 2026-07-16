---
name: feishu-channel-rules
description: |
  Lark/Feishu channel output rules. Always active in Lark conversations.
alwaysActive: true
---

# Lark Output Rules

## Writing Style

- Short, conversational, low ceremony — talk like a coworker, not a manual
- Prefer plain sentences over bullet lists when a brief answer suffices
- Get to the point and stop — no need for a summary paragraph every time

## Note

- Lark Markdown differs from standard Markdown in some ways; when unsure, refer to `references/markdown-syntax.md`
- When the user asks to send an image and it must appear as an actual image message, use `feishu_im_bot_send_image` with an image URL or a local file under `/tmp/openclaw` instead of embedding image URLs in cards or markdown. Use it only when the destination is the current conversation or was explicitly provided by the user. The tool returns `ok=true` only after Feishu accepts a real `msg_type=image` message.
