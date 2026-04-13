---
name: feishu-raw-api
description: |
  飞书通用 API 调用工具，可访问任意 Feishu/Lark API 端点。
  **当以下情况时使用此 Skill**：
  (1) 需要的 API 没有对应的专用工具（如 Mail、VC/Meeting、Approval、OKR）
  (2) 需要调用尚未被 openclaw-lark 插件支持的新 API
  **不要使用**：有专用工具时优先使用专用工具（feishu_sheet、feishu_calendar 等）。
---

# Feishu Raw API (通用 API) Skill

## 执行前必读

- **优先级原则**：`feishu_raw_api` 是**最后手段**。如果存在专用工具，必须先使用专用工具：
  - 日历 → `feishu_calendar`
  - 表格/Sheet → `feishu_sheet`
  - 多维表格 → `feishu_bitable_*`
  - 文档 → `feishu_doc_*`
  - 即时消息 → `feishu_im_*`
  - 任务 → `feishu_task_*`
- **发现参数**：使用 `lark-cli schema <path>` 查询指定 API 端点的请求/响应 Schema，再填写参数。
- **写操作必须确认**：所有 POST / PUT / PATCH 操作在执行前必须向用户确认操作内容与影响范围。
- **默认身份**：未指定 `as` 时使用 `tenant`（机器人身份）；涉及用户个人数据时需使用 `as: "user"`（需 OAuth）。

---

## 决策树

```
需要调用飞书 API
       │
       ▼
是否有专用工具覆盖此功能？
  ├── 是 → 使用专用工具（feishu_sheet / feishu_calendar / feishu_bitable_* / …）
  └── 否 → 使用 feishu_raw_api
              │
              ▼
         lark-cli schema <path> 查询 API 参数
              │
              ▼
         构造请求（method + path + params/data）
              │
              ▼
         写操作？
           ├── 是 → 向用户确认后执行
           └── 否 → 直接执行
```

---

## 快速索引：常用 API 路径

### 邮件 (Mail)

| 功能 | Method | Path |
|------|--------|------|
| 查询邮件组列表 | GET | `/open-apis/mail/v1/mailgroups` |
| 创建邮件组 | POST | `/open-apis/mail/v1/mailgroups` |
| 查询邮件组成员 | GET | `/open-apis/mail/v1/mailgroups/{mailgroup_id}/members` |
| 添加邮件组成员 | POST | `/open-apis/mail/v1/mailgroups/{mailgroup_id}/members` |
| 查询用户邮箱别名 | GET | `/open-apis/mail/v1/user_mailboxes/{user_mailbox_id}/aliases` |

### 视频会议 (VC/Meeting)

| 功能 | Method | Path |
|------|--------|------|
| 预约会议 | POST | `/open-apis/vc/v1/reserves/apply` |
| 查询会议详情 | GET | `/open-apis/vc/v1/meetings/{meeting_id}` |
| 查询会议室列表 | GET | `/open-apis/vc/v1/rooms` |
| 查询会议录制 | GET | `/open-apis/vc/v1/meetings/{meeting_id}/recordings` |
| 查询参会人员 | GET | `/open-apis/vc/v1/meetings/{meeting_id}/participants` |

### 审批 (Approval)

| 功能 | Method | Path |
|------|--------|------|
| 查询审批定义列表 | GET | `/open-apis/approval/v4/approvals` |
| 创建审批实例 | POST | `/open-apis/approval/v4/instances` |
| 查询审批实例详情 | GET | `/open-apis/approval/v4/instances/{instance_id}` |
| 审批通过 | POST | `/open-apis/approval/v4/instances/approve` |
| 查询我的审批任务 | GET | `/open-apis/approval/v4/tasks/query` |

### OKR

| 功能 | Method | Path |
|------|--------|------|
| 查询用户 OKR 列表 | GET | `/open-apis/okr/v1/periods` |
| 查询 OKR 详情 | GET | `/open-apis/okr/v1/okrs/{okr_id}` |
| 查询进展记录 | GET | `/open-apis/okr/v1/progress_records` |
| 创建进展记录 | POST | `/open-apis/okr/v1/progress_records` |

---

## 分页处理

飞书 API 分页统一使用 `page_token` + `page_size`。`feishu_raw_api` 原生支持这两个参数，会自动合并到 query string。

**第一页**：
```json
{
  "method": "GET",
  "path": "/open-apis/mail/v1/mailgroups",
  "page_size": 50
}
```

**响应示例**：
```json
{
  "code": 0,
  "data": {
    "items": [...],
    "page_token": "xxx_next_token",
    "has_more": true
  }
}
```

**翻页**（`has_more` 为 `true` 时继续）：
```json
{
  "method": "GET",
  "path": "/open-apis/mail/v1/mailgroups",
  "page_size": 50,
  "page_token": "xxx_next_token"
}
```

**终止条件**：响应中 `has_more` 为 `false` 或 `page_token` 为空时停止翻页。

---

## 安全规则

| HTTP Method | 风险级别 | 操作要求 |
|-------------|---------|---------|
| GET | 低（只读） | 直接执行，无需确认 |
| POST | 中（创建资源） | 执行前向用户确认创建内容 |
| PUT / PATCH | 中（修改资源） | 执行前向用户确认修改内容和影响范围 |
| DELETE | 高（不可逆） | 执行前**双重确认**：说明将删除的资源 ID 及影响，等待用户明确同意 |

**身份选择**：
- `as: "tenant"`（默认）：机器人身份，适用于系统级操作（创建邮件组、管理会议室等）
- `as: "user"`：用户 OAuth 身份，适用于代表用户操作个人数据（个人日历、个人 OKR 等）；需要用户已完成 OAuth 授权

---

## 参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `method` | string | 是 | HTTP 方法：`GET` / `POST` / `PUT` / `PATCH` / `DELETE` |
| `path` | string | 是 | 飞书 API 路径，必须以 `/open-apis/` 开头，例如 `/open-apis/mail/v1/mailgroups` |
| `params` | object | 否 | URL Query 参数，键值对形式，例如 `{"user_id_type": "open_id"}` |
| `data` | object | 否 | 请求体 JSON，适用于 POST / PUT / PATCH |
| `as` | string | 否 | 调用身份：`"tenant"`（机器人，默认）或 `"user"`（用户 OAuth） |
| `page_token` | string | 否 | 分页 token，来自上一次响应的 `page_token` 字段 |
| `page_size` | integer | 否 | 每页数量，范围 1-500，具体上限由各 API 决定 |
