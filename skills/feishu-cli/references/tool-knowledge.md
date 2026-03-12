# Feishu Tool Business Rules

Non-obvious constraints beyond what `feishu-cli describe` shows. Grouped by domain.

## Table of Contents

- [Calendar](#calendar)
- [Task](#task)
- [Document (Create/Update/Fetch)](#document)
- [Bitable (Multi-dimensional Tables)](#bitable)
- [IM (Messages)](#im)
- [Troubleshooting](#troubleshooting)
- [Cross-tool Constraints](#cross-tool)

---

## Calendar

**feishu_calendar_event**

- `user_open_id` is practically **required** for `create` (schema says optional). Without it, events only appear on app calendar, invisible to user. Pass SenderId (`ou_xxx`).
- `attendee_ability` defaults to `none`. Set `can_modify_event` to let attendees edit.
- Meeting room (`type: "resource"`) booking is **async**: API returns `needs_action`, final status resolves later. Check with `feishu_calendar_event_attendee.list`.
- `instances` action only works on recurring events (those with `recurrence` field). Calling on normal events returns error.
- `list` action uses `instance_view` internally: auto-expands recurring events, time range max 40 days, max 1000 instances.
- Time format: ISO 8601 with timezone, e.g. `2026-03-01T14:00:00+08:00`. Never use Unix timestamps.

**feishu_calendar_freebusy**

- `user_ids` is an array, supports 1-10 users. Does NOT support meeting rooms.

**ID formats**: Users `ou_xxx`, groups `oc_xxx`, rooms `omm_xxx`, email `email@...`.

---

## Task

**feishu_task_task**

- Uses user access token: user can only edit tasks where they are a member.
- Always pass `current_user_id` (= SenderId) so creator is auto-added as follower.
- `completed_at` has 3 modes: ISO 8601 string (complete), `"0"` (un-complete), millisecond timestamp string.
- Member roles: `assignee` (editor) vs `follower` (notification only).
- Time: ISO 8601 with timezone.

**feishu_task_tasklist**

- Creator auto-becomes owner. If creator is also in `members` list, they're removed (role conflict). Never include creator in members.
- `task_guid` and `tasklist_guid` are different ID formats — don't mix.

---

## Document

### feishu_create_doc

- Content uses **Lark-flavored Markdown** (superset of standard Markdown).
- `title` sets doc title; do NOT repeat it as H1 in markdown body.
- Extended tags: `<callout>`, `<grid>/<column>`, `<lark-table>/<lark-tr>/<lark-td>`, `<image url="..."/>`, `<mention-user id="ou_xxx"/>`.
- Images via `<image url="https://..."/>` — system downloads and uploads automatically. No `token` attribute for creation.
- Mermaid/PlantUML code blocks auto-convert to whiteboards.
- `folder_token`, `wiki_node`, `wiki_space` are mutually exclusive location params. Priority: `wiki_node` > `wiki_space` > `folder_token`.
- For long docs: create first portion, then use `feishu_update_doc` append mode for remaining.

### feishu_update_doc

- **Prefer `replace_range`** for targeted changes (safest, preserves media).
- Avoid `overwrite` unless full doc rebuild needed (loses images, comments, history).
- `selection_with_ellipsis`: `开头文字...结尾文字` matches range between. Use 10-20 chars for uniqueness.
- `selection_by_title`: `## Chapter Title` targets entire section until next same-level heading.
- Embedded media (images, whiteboards) are token-based — avoid replacing areas containing them.
- Large operations may return `task_id` instead of immediate success — re-call with only `task_id` to check status.
- `new_title`: plain text, 1-800 chars, can combine with any update mode.

### feishu_fetch_doc

- Returns Lark-flavored Markdown.
- Media appears as HTML tags (`<image token="..."/>`, `<file token="..."/>`, `<whiteboard token="..."/>`). Must call `feishu_doc_media` separately to download.
- Wiki URLs (`/wiki/TOKEN`): call `feishu_wiki_space_node` (action: get) first to determine `obj_type`, then route to correct tool.
- Accepts full URL, token, or wiki URL as doc_id.

---

## Bitable

**Record value formats (most common errors)**

| Field type | Correct format | Wrong format |
|-----------|---------------|-------------|
| People | `[{id: "ou_xxx"}]` | `"ou_xxx"` or `[{name: "..."}]` |
| Date | `1674206443000` (ms timestamp) | ISO string or seconds |
| Single-select | `"option_name"` | `["option_name"]` |
| Multi-select | `["opt1", "opt2"]` | `"opt1"` |
| URL | `{link: "...", text: "..."}` | `"https://..."` |
| Attachment | Pre-uploaded `file_token` | URL or base64 |

**Workflow**: Always call `feishu_bitable_app_table_field.list` BEFORE writing records to get field types.

**Gotchas**:
- `app.create` ships with empty rows in default table — `list` + `batch_delete` records before inserting.
- `isEmpty`/`isNotEmpty` filters require `value: []` (empty array).
- Max 500 records per batch operation.
- No concurrent writes to same table — serialize with 0.5-1s delay.

---

## IM

**feishu_im_user_get_messages**

- `open_id` and `chat_id` are mutually exclusive — choose one.
- `relative_time` and `start_time`/`end_time` are mutually exclusive.
- Page size 1-50, default 50. Follow `page_token` when `has_more=true`.

**feishu_im_user_get_thread_messages**

- Does NOT support time filtering — pagination only.

**feishu_im_user_fetch_resource**

- Requires `message_id` + `file_key` + `type` together.
- Extract keys from message content: `![image](img_xxx)`, `<file key="file_xxx" .../>`.
- 100MB file size limit.

**Thread expansion**: When messages contain `thread_id`, proactively fetch thread replies (10-50 messages) for context.

---

## Troubleshooting

- Card buttons unresponsive: App missing `card.action.trigger` callback permission.
- Use `/feishu doctor` only for complex/recurrent auth failures, not routine permission issues.

---

## Cross-tool

- **SenderId** (`ou_xxx`): Use as `user_open_id` (calendar), `current_user_id` (task), member IDs. Always available from user context.
- **Timezone**: Feishu defaults to `+08:00` (Beijing). Always include timezone in time params.
- **Serialize writes**: Bitable and Task both require sequential operations, no concurrent writes.
- **Media tokens are ephemeral**: Always extract fresh from fetch results, never cache.
