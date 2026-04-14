---
name: feishu-task
description: |
  飞书任务管理工具,用于创建、查询、更新任务和清单。

  **当以下情况时使用此 Skill**:
  (1) 需要创建、查询、更新任务
  (2) 需要创建、管理任务清单
  (3) 需要查看任务列表或清单内的任务
  (4) 用户提到"任务"、"待办"、"to-do"、"清单"、"task"
  (5) 需要设置任务负责人、关注人、截止时间、添加成员
---

# 飞书任务管理

## 🚨 执行前必读

- ✅ **时间格式**：ISO 8601 / RFC 3339（带时区），例如 `2026-02-28T17:00:00+08:00`
- ✅ **身份授权**：工具支持 `auth_type` 为 `user`（默认，用户身份）或 `tenant`（应用身份）。
- ✅ **current_user_id 强烈建议**：从消息上下文的 SenderId 获取（ou_...），工具会自动添加为 follower（如不在 members 中），确保创建者可以编辑任务
- ✅ **patch/get 必须**：task_guid
- ✅ **tasklist.tasks 必须**：tasklist_guid
- ✅ **完成任务**：completed_at = "2026-02-26 15:00:00"
- ✅ **反完成（恢复未完成）**：completed_at = "0"

---

## 📋 快速索引：意图 → 工具 → 必填参数

| 用户意图 | 工具 | action | 必填参数 | 强烈建议 | 常用可选 |
|---------|------|--------|---------|---------|---------|
| 新建待办 | feishu_task_task | create | summary | current_user_id（SenderId） | members, due, description, auth_type |
| 查未完成任务 | feishu_task_task | list | - | completed=false | page_size, auth_type |
| 获取任务详情 | feishu_task_task | get | task_guid | - | auth_type |
| 完成任务 | feishu_task_task | patch | task_guid, completed_at | - | auth_type |
| 反完成任务 | feishu_task_task | patch | task_guid, completed_at="0" | - | auth_type |
| 改截止时间 | feishu_task_task | patch | task_guid, due | - | auth_type |
| 添加任务成员 | feishu_task_task | add_members | task_guid, members[] | - | auth_type |
| 创建清单 | feishu_task_tasklist | create | name | - | members |
| 查看清单任务 | feishu_task_tasklist | tasks | tasklist_guid | - | completed |
| 添加清单成员 | feishu_task_tasklist | add_members | tasklist_guid, members[] | - | - |

---

## 🎯 核心约束（Schema 未透露的知识）

### 1. 授权身份与可见性 (auth_type)

**工具支持两种调用身份 `auth_type`**：
- **`user` (默认)**：用户身份（user_access_token）。用于需要严格代表用户操作或查询用户私有任务的场景。
  - ⚠️ 使用 `user` 身份时，只能查看和编辑**自己是成员的任务**。
  - ⚠️ **如果创建时没把自己加入成员，后续无法编辑该任务**。
- **`tenant`**：应用身份（tenant_access_token）。当用户身份不满足要求时，使用应用身份。如果创建的任务没有把用户加入成员，用户可能看不见。

**自动保护机制**：
- 传入 `current_user_id` 参数（从 SenderId 获取）
- 如果 `members` 中不包含 `current_user_id`，工具会**自动添加为 follower**
- 确保创建者始终可以编辑和查看任务

### 2. 任务成员的角色与类型

- **角色 (role)**：
  - **assignee（负责人）**：负责完成任务，可以编辑任务
  - **follower（关注人）**：关注任务进展，接收通知
- **类型 (type)**：
  - **user（默认，用户）**：普通的飞书用户
  - **app（应用/机器人）**：如果是把机器人自己或者其他应用加入任务，必须指定 `type: "app"`

**添加成员示例**：
```json
{
  "members": [
    {"id": "ou_xxx", "role": "assignee", "type": "user"},  // 负责人（用户）
    {"id": "cli_yyy", "role": "follower", "type": "app"}   // 关注人（机器人/应用）
  ]
}
```

**说明**：`id` 默认使用 `open_id`。

### 3. 任务清单角色冲突

**现象**：创建清单（`tasklist.create`）时传了 `members`，但返回的 `tasklist.members` 为空或缺少成员

**原因**：创建人自动成为清单 **owner**（所有者），如果 `members` 中包含创建人，该用户最终成为 owner 并从 `members` 中移除（同一用户只能有一个角色）

**建议**：不要在 `members` 中包含创建人，只添加其他协作成员

### 4. completed_at 的三种用法

**1) 完成任务（设置完成时间）**：
```json
{
  "action": "patch",
  "task_guid": "xxx",
  "completed_at": "2026-02-26 15:30:00"  // 北京时间字符串
}
```

**2) 反完成（恢复未完成状态）**：
```json
{
  "action": "patch",
  "task_guid": "xxx",
  "completed_at": "0"  // 特殊值 "0" 表示反完成
}
```

**3) 毫秒时间戳**（不推荐，除非上层已严格生成）：
```json
{
  "completed_at": "1740545400000"  // 毫秒时间戳字符串
}
```

### 5. 清单成员的角色

| 成员类型 | 角色 | 说明 |
|---------|------|------|
| user（用户） | owner | 所有者，可转让所有权 |
| user（用户） | editor | 可编辑，可修改清单和任务 |
| user（用户） | viewer | 可查看，只读权限 |
| chat（群组） | editor/viewer | 整个群组获得权限 |

**说明**：创建清单时，创建者自动成为 owner，无需在 members 中指定。

---

## 📌 使用场景示例

### 场景 1: 创建任务并分配负责人

```json
{
  "action": "create",
  "summary": "准备周会材料",
  "description": "整理本周工作进展和下周计划",
  "current_user_id": "ou_发送者的open_id",
  "auth_type": "tenant",
  "due": {
    "timestamp": "2026-02-28 17:00:00",
    "is_all_day": false
  },
  "members": [
    {"id": "ou_协作者的open_id", "role": "assignee", "type": "user"}
  ]
}
```

**说明**：
- `summary` 是必填字段
- `current_user_id` 强烈建议传入（从 SenderId 获取），工具会自动添加为 follower
- `members` 可以只包含其他协作者，当前用户会被自动添加
- 时间使用带时区的 ISO 8601 格式

### 场景 2: 查询我负责的未完成任务

```json
{
  "action": "list",
  "completed": false,
  "page_size": 20,
  "auth_type": "user"
}
```

### 场景 3: 为现有任务添加机器人或成员

```json
{
  "action": "add_members",
  "task_guid": "任务的guid",
  "auth_type": "tenant",
  "members": [
    {"id": "cli_机器人的app_id", "role": "follower", "type": "app"}
  ]
}
```

### 场景 4: 完成任务

```json
{
  "action": "patch",
  "task_guid": "任务的guid",
  "completed_at": "2026-02-26 15:30:00"
}
```

### 场景 5: 反完成任务（恢复未完成状态）

```json
{
  "action": "patch",
  "task_guid": "任务的guid",
  "completed_at": "0"
}
```

### 场景 6: 创建清单并添加协作者

```json
{
  "action": "create",
  "name": "产品迭代 v2.0",
  "members": [
    {"id": "ou_xxx", "role": "editor"},
    {"id": "ou_yyy", "role": "viewer"}
  ]
}
```

### 场景 7: 查看清单内的未完成任务

```json
{
  "action": "tasks",
  "tasklist_guid": "清单的guid",
  "completed": false
}
```

### 场景 8: 全天任务

```json
{
  "action": "create",
  "summary": "年度总结",
  "due": {
    "timestamp": "2026-03-01 00:00:00",
    "is_all_day": true
  }
}
```

---

## 🔍 常见错误与排查

| 错误现象 | 根本原因 | 解决方案 |
|---------|---------|---------|
| **创建后无法编辑任务** | 创建时未将自己加入 members | 创建时至少将当前用户（SenderId）加为 assignee 或 follower |
| **patch 失败提示 task_guid 缺失** | 未传 task_guid 参数 | patch/get/add_members 必须传 task_guid |
| **tasks 失败提示 tasklist_guid 缺失** | 未传 tasklist_guid 参数 | tasklist.tasks action 必须传 tasklist_guid |
| **反完成失败** | completed_at 格式错误 | 使用 `"0"` 字符串，不是数字 0 |
| **时间不对** | 使用了 Unix 时间戳 | 改用 ISO 8601 格式（带时区）：`2024-01-01T00:00:00+08:00` |
| **添加机器人失败** | 未指定成员 type 为 app | 将机器人的 type 指定为 `"app"` |

---

## 📚 附录：背景知识

### A. 资源关系

```
任务清单（Tasklist）
  └─ 自定义分组（Section，可选）
      └─ 任务（Task）
          ├─ 成员：负责人（assignee）、关注人（follower）
          ├─ 子任务（Subtask）
          ├─ 截止时间（due）、开始时间（start）
          └─ 附件、评论
```

**核心概念**：
- **任务（Task）**：独立的待办事项，有唯一的 `task_guid`
- **清单（Tasklist）**：组织多个任务的容器，有唯一的 `tasklist_guid`
- **负责人（assignee）**：可以编辑任务并标记完成
- **关注人（follower）**：接收任务更新通知
- **我负责的（MyTasks）**：所有负责人为自己的任务集合

### B. 如何获取 GUID

- **task_guid**：创建任务后从返回值的 `task.guid` 获取，或通过 `list` 查询
- **tasklist_guid**：创建清单后从返回值的 `tasklist.guid` 获取，或通过 `list` 查询

### C. 如何将任务加入清单

创建任务时指定 `tasklists` 参数：
```json
{
  "action": "create",
  "summary": "任务标题",
  "tasklists": [
    {
      "tasklist_guid": "清单的guid",
      "section_guid": "分组的guid（可选）"
    }
  ]
}
```

### D. 重复任务如何创建

使用 `repeat_rule` 参数，采用 RRULE 格式：
```json
{
  "action": "create",
  "summary": "每周例会",
  "due": {"timestamp": "2026-03-03 14:00:00", "is_all_day": false},
  "repeat_rule": "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO"
}
```

**说明**：只有设置了截止时间的任务才能设置重复规则。


### E. 数据权限

- 只能操作自己有权限的任务（作为成员的任务）
- 只能操作自己有权限的清单（作为成员的清单）
- 将任务加入清单需要同时拥有任务和清单的编辑权限
