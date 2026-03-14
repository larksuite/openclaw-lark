# 模思智能飞书插件维护手册

> 给下一个龙虾 + 人类管理员

---

## 架构说明

飞书插件有两个来源，**只用 workspace 版**：

| 位置 | 类型 | 状态 |
|------|------|------|
| `~/.openclaw/workspace/third_party/openclaw-lark` | Git fork，TypeScript 源码 | ✅ 当前在用 |
| `~/.openclaw/extensions/openclaw-lark.disabled` | npm 安装版，已编译 JS | ❌ 已禁用（rename 为 .disabled） |

OpenClaw 用 **Jiti** 在运行时直接转译 TypeScript，不需要 build/dist。

上游仓库：`https://github.com/larksuite/openclaw-lark.git`

---

## 我们打的补丁（共 2 个 commit）

### Patch 1 — `ownerOnly` 开关（commit `3905650`）

**文件**：`src/core/owner-policy.ts`

**问题**：默认只有 app owner 能发起 OAuth 授权（非 owner 一律拒绝）。

**修改**：`assertOwnerAccessStrict` 读取 `account.config.uat?.ownerOnly` 配置，设为 `false` 时跳过 owner 检查，允许任意用户授权。

**对应 GitHub Issue**：[#5](https://github.com/larksuite/openclaw-lark/issues/5)、[#12](https://github.com/larksuite/openclaw-lark/issues/12)、[#75](https://github.com/larksuite/openclaw-lark/issues/75)，PR [#11](https://github.com/larksuite/openclaw-lark/pull/11)（上游尚未 merge）。

**配置**（`~/.openclaw/openclaw.json`）：
```json
{
  "channels": {
    "feishu": {
      "uat": {
        "enabled": true,
        "ownerOnly": false
      }
    }
  }
}
```

---

### Patch 2 — 代授权支持（commit `ddeffde`）

**文件**：`src/tools/oauth.ts`

**问题**：OAuth 回调时，插件会校验"点击授权链接的人"和"发起授权请求的人"是否是同一账号。A 发起 → B 点击 → 报"操作账号与发起账号不一致"。

**修改**：新增 `isDelegatedAuthAllowed()` 函数，当配置了 `allowDelegatedAuth: true` 且两方 open_id 都在白名单里时，放行代授权。

**配置**（可选，默认不开）：
```json
{
  "channels": {
    "feishu": {
      "uat": {
        "allowDelegatedAuth": true,
        "delegatedAuthOpenIds": ["ou_发起人的open_id", "ou_点击授权的人的open_id"]
      }
    }
  }
}
```

---

## 上游更新流程

```bash
cd ~/.openclaw/workspace/third_party/openclaw-lark

# 1. 拉取上游最新
git fetch origin

# 2. Rebase 我们的补丁到最新上游
git rebase origin/main

# 如果有冲突，手动解决后：
# git add <冲突文件>
# git rebase --continue

# 3. 重启 gateway
openclaw gateway restart

# 4. 验证插件正常加载（无报错）
openclaw gateway status
```

**注意**：不要用 `openclaw plugins install @larksuite/openclaw-lark` 更新，那会重新装 npm 版覆盖 workspace 版。

---

## 人类管理员操作手册

### 一、飞书开发者后台（必做，每次新增机器人账号时）

**问题**：群成员点击授权链接时看到"无 XXX 使用权限"。

**根因**：飞书应用的"可用范围"只包含了 owner，未开放给其他成员。

**操作步骤**：
1. 打开 [open.feishu.cn](https://open.feishu.cn) → 我的应用 → 找到对应机器人
2. 左侧菜单 → **版本管理与发布**
3. 点击 **创建版本**（或编辑现有草稿版本）
4. 找到 **可用范围** 选项
5. 改为「全员可用」，或按需添加具体成员/部门
6. 提交申请发布（企业自建应用通常自动通过）

---

### 二、openclaw.json 配置（允许任意成员使用 bot）

必须有：
```json
"channels": {
  "feishu": {
    "uat": {
      "enabled": true,
      "ownerOnly": false
    }
  }
}
```

修改后重启：
```bash
openclaw gateway restart
```

---

### 三、新同学第一次用 bot 的完整流程

1. 在群里 @bot 发起需要读文档的请求
2. Bot 自动发送授权卡片
3. 同学点卡片 → 飞书 OAuth 页面 → 登录 → 授权
4. Bot 收到回调，验证身份，存储 token
5. 继续执行原来的操作

**常见问题**：

| 现象 | 原因 | 处理 |
|------|------|------|
| "无 XXX 使用权限" | 飞书应用可用范围未包含此人 | 管理员去开发者后台改可用范围并重新发布 |
| "操作账号与发起账号不一致" | 点授权链接时用的不是发起请求的那个飞书账号 | 让发起人本人点击；或配置 delegatedAuthOpenIds |
| Bot 不回复 | Gateway 可能挂了 | `openclaw gateway status` / `openclaw gateway restart` |
| 授权成功但 bot 说 token 过期 | UAT 过期 | 告诉 bot "撤销授权"，bot 会重新发起授权流程 |

---

## 相关文件

```
~/.openclaw/
├── openclaw.json                          # 主配置
├── workspace/third_party/openclaw-lark/   # 插件源码（本文档所在位置）
│   ├── src/core/owner-policy.ts           # Patch 1
│   ├── src/tools/oauth.ts                 # Patch 2
│   └── MOSI-PATCHES.md                   # 本文档
└── extensions/openclaw-lark.disabled/    # npm 版（已禁用，备用）
```
