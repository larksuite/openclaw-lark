---
name: feishu-im-read
description: |
  飞书 IM 消息读取工具使用指南，覆盖会话消息获取、话题回复读取、跨会话消息搜索、图片/文件资源下载。

  **当以下情况时使用此 Skill**:
  (1) 需要获取群聊或单聊的历史消息
  (2) 需要读取话题（thread）内的回复消息
  (3) 需要跨会话搜索消息（按关键词、发送者、时间等条件）
  (4) 消息中包含图片、文件、音频、视频，需要下载
  (5) 用户提到"聊天记录"、"消息"、"群里说了什么"、"话题回复"、"搜索消息"、"图片"、"文件下载"
  (6) 需要按时间范围过滤消息、分页获取更多消息
---

# 飞书 IM 消息读取

## 执行前必读

- `feishu_im_user_*` 以用户身份调用；`feishu_im_bot_*` 使用 tenant_access_token，无需用户 OAuth 授权。要求应用身份或无用户授权时，使用 bot 工具
- bot 工具只能读取应用可见且机器人有权访问的会话；群消息需机器人在群内，并开通应用权限 `im:message.group_msg`，单聊需 `im:message.p2p_msg:readonly`；搜索另需 `search:message`
- bot 历史消息工具必须提供 `chat_id`，不支持 `open_id`；单聊仅指用户与机器人的单聊
- 读取 bot 消息后，话题上下文使用 `feishu_im_bot_get_thread_messages`，资源下载使用 `feishu_im_bot_image`，保持应用身份
- `feishu_im_user_get_messages` 中 `open_id` 和 `chat_id` 必须二选一
- 消息中出现 `thread_id` 时，根据用户意图使用同身份的话题工具读取回复
- 以用户身份读取后，如果消息内容中出现资源标记时，用 `feishu_im_user_fetch_resource` 下载，需要 `message_id` + `file_key` + `type`

---

## 快速索引：意图 → 工具

| 用户意图 | 工具 | 必填参数 | 常用可选 |
|---------|------|---------|---------|
| 以应用身份获取会话历史消息 | feishu_im_bot_get_messages | chat_id | relative_time, start_time/end_time, page_size, page_token, sort_rule |
| 以应用身份获取话题消息 | feishu_im_bot_get_thread_messages | thread_id（omt_xxx） | page_size, page_token, sort_rule |
| 以应用身份跨会话搜索 | feishu_im_bot_search_messages | 至少一个有效过滤条件 | query, chat_id, sender_ids, mention_ids, message_type, sender_type, chat_type, relative_time, page_size, page_token |
| 获取群聊/单聊历史消息 | feishu_im_user_get_messages | chat_id 或 open_id（二选一） | relative_time, start_time/end_time, page_size, sort_rule |
| 获取话题内回复消息 | feishu_im_user_get_thread_messages | thread_id（omt_xxx） | page_size, sort_rule |
| 跨会话搜索消息 | feishu_im_user_search_messages | 至少一个过滤条件 | query, sender_ids, chat_id, relative_time, start_time/end_time, page_size |
| 下载消息中的图片 | feishu_im_user_fetch_resource | message_id, file_key（img_xxx）, type="image" | - |
| 下载消息中的文件/音频/视频 | feishu_im_user_fetch_resource | message_id, file_key（file_xxx）, type="file" | - |

---

## 应用身份工具的差异

- 搜索使用 `POST /open-apis/im/v1/messages/search`，按机器人可访问范围搜索，不代表可以读取租户内所有聊天。
- `sender_type` 默认 `all`；`message_type` 是附件过滤，支持 `file/image/video/link`，兼容 `media` 作为 `video` 的别名。
- 时间参数沿用用户工具，`relative_time` 与 `start_time/end_time` 互斥；话题工具不支持时间过滤。
- 消息格式与用户工具一致，但不查询用户通讯录或用户姓名缓存，姓名不可用时保留 ID。
- 会话名称补充需要应用权限 `im:chat:read`；补充失败返回 `warning`，仍返回消息。详情缺失会列出 `missing_message_ids`。
- 搜索返回服务端 `notice` 时应保留并向用户说明，不能把受限结果当作完整历史；`has_more=true` 时用原过滤条件和新 `page_token` 继续。
- 应用权限不足时由管理员开通权限，不应转为用户 OAuth 授权。

接口契约参考：[飞书官方 CLI 搜索实现](https://github.com/larksuite/cli/blob/39aaf9fca0e08825b51f6d8c6c617bf781db761b/shortcuts/im/im_messages_search.go)。

## 核心约束

### 1. 时间范围：确保消息覆盖完整

当用户没有明确指定时间范围时，根据用户意图推断合适的 `relative_time`，确保返回的消息能完整覆盖用户关心的内容。用户明确指定时间时直接使用用户的值。

### 2. 分页：根据需要翻页获取更多结果

- `page_size` 范围 1-50，默认 50
- 返回结果中 `has_more=true` 时，可使用 `page_token` 继续获取下一页
- 根据用户需求判断是否需要翻页：需要完整结果时继续翻页，浏览概览时第一页通常够用

### 3. 话题回复：主动展开话题获取上下文

获取历史消息时，返回的消息中如果包含 `thread_id` 字段，推荐主动获取话题的最新 10 条回复（`page_size: 10, sort_rule: "create_time_desc"`）以提供更完整的上下文。

| 场景 | 行为 |
|------|------|
| 获取历史消息并需要理解上下文（默认） | 对发现的 thread_id 调用同身份的 `feishu_im_user_get_thread_messages` 或 `feishu_im_bot_get_thread_messages` 获取最新 10 条回复 |
| 用户要求"完整对话"、"详细讨论"、"看看回复" | 获取话题全部回复（`page_size: 50, sort_rule: "create_time_asc"`），需要时翻页 |
| 用户只浏览消息概览 / 用户明确说不看回复 | 跳过话题展开 |

**注意**：话题消息不支持时间过滤（飞书 API 限制），只能通过分页获取。

### 4. 跨会话消息搜索

`feishu_im_user_search_messages` 支持跨所有会话搜索消息：

| 参数 | 说明 |
|------|------|
| `query` | 搜索关键词，匹配消息内容 |
| `sender_ids` | 发送者 open_id 列表 |
| `chat_id` | 限定搜索范围的会话 ID |
| `mention_ids` | 被@用户的 open_id 列表 |
| `message_type` | 消息类型：file / image / media |
| `sender_type` | 发送者类型：user / bot / all（默认 user） |
| `chat_type` | 会话类型：group / p2p |

搜索结果每条消息额外包含 `chat_id`、`chat_type`（p2p/group）、`chat_name`。单聊消息还有 `chat_partner`（对方 open_id 和名字）。

### 5. 图片/文件/媒体资源的提取

消息内容中可能出现以下资源标记；用户身份使用 `feishu_im_user_fetch_resource`，应用身份使用 `feishu_im_bot_image` 下载：

| 资源类型 | 内容中的标记格式 | fetch_resource 参数 |
|---------|-----------------|-------------------|
| 图片 | `![image](img_xxx)` | message_id=`om_xxx`, file_key=`img_xxx`, type=`"image"` |
| 文件 | `<file key="file_xxx" .../>` | message_id=`om_xxx`, file_key=`file_xxx`, type=`"file"` |
| 音频 | `<audio key="file_xxx" .../>` | message_id=`om_xxx`, file_key=`file_xxx`, type=`"file"` |
| 视频 | `<video key="file_xxx" .../>` | message_id=`om_xxx`, file_key=`file_xxx`, type=`"file"` |

从消息的 `message_id` 字段和内容中的 `file_key` 组合即可调用 fetch_resource。

**注意**：文件大小限制 100MB，不支持下载表情包、卡片中的资源。

### 6. 时间过滤

`feishu_im_user_get_messages` 和 `feishu_im_user_search_messages` 支持时间过滤，话题消息不支持。

| 方式 | 参数 | 示例 |
|------|------|------|
| 相对时间 | `relative_time` | `today`、`yesterday`、`this_week`、`last_3_days`、`last_24_hours` |
| 精确时间 | `start_time` + `end_time` | ISO 8601 格式：`2026-02-27T00:00:00+08:00` |

- `relative_time` 和 `start_time/end_time` **互斥**，不能同时使用
- 可用的 relative_time 值：`today`、`yesterday`、`day_before_yesterday`、`this_week`、`last_week`、`this_month`、`last_month`、`last_{N}_{unit}`（unit: minutes/hours/days）

### 7. open_id 与 chat_id 的选择

| 参数 | 格式 | 适用场景 |
|------|------|---------|
| chat_id | `oc_xxx` | 已知会话 ID（群聊或单聊均可） |
| open_id | `ou_xxx` | 已知用户 ID，获取与该用户的单聊消息（自动解析为 chat_id） |

两者必须二选一，优先使用 `chat_id`。

---

## 使用场景示例

### 场景 1: 获取群聊消息并展开话题

**步骤 1**：获取群聊消息
```json
{ "chat_id": "oc_xxx" }
```

**步骤 2**：返回的消息中发现 `thread_id`，展开话题最新回复：
```json
{ "thread_id": "omt_xxx", "page_size": 10, "sort_rule": "create_time_desc" }
```

### 场景 2: 跨会话搜索消息

```json
{ "query": "项目进度", "chat_id": "oc_xxx" }
```

### 场景 3: 分页获取更多消息

第一次调用返回 `has_more: true` 和 `page_token: "xxx"`，继续获取：
```json
{ "chat_id": "oc_xxx", "page_token": "xxx" }
```

### 场景 4: 下载消息中的资源

```json
{ "message_id": "om_xxx", "file_key": "img_v3_xxx", "type": "image" }
```

---

## 常见错误与排查

| 错误现象 | 根本原因 | 解决方案 |
|---------|---------|---------|
| 消息结果太少 | 时间范围太窄或未传时间参数 | 根据用户意图推断合适的 `relative_time` |
| 消息不完整 | 没有检查 has_more 并翻页 | has_more=true 时用 page_token 翻页 |
| 话题讨论内容不完整 | 没有展开 thread_id | 发现 thread_id 时获取话题回复 |
| "open_id 和 chat_id 不能同时提供" | 同时传了两个参数 | 只传其中一个 |
| "relative_time 和 start_time/end_time 不能同时使用" | 时间参数冲突 | 选择一种时间过滤方式 |
| "未找到与 open_id=xxx 的单聊会话" | 没有单聊记录 | 改用 chat_id，或确认存在单聊 |
| 话题消息返回为空 | thread_id 格式不正确 | 确认为 `omt_xxx` 格式 |
| 图片/文件下载失败 | file_key 或 message_id 不匹配 | 确认 file_key 来自该 message_id |
| 权限不足 | 用户未授权或无权限 | 确认已完成 OAuth 授权且是会话成员 |
