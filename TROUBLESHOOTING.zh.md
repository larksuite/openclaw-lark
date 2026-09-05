# OpenClaw 2.0 升级后：连接正常但消息没有回复

以下说明基于 OpenClaw 2026.9.1。插件加载兼容和消息路由是两层不同的问题，必须分别检查。

## 1. 先排除插件接口不兼容

如果日志出现 `ERR_PACKAGE_PATH_NOT_EXPORTED`、`runtime.config.loadConfig is not a function` 等错误，说明插件还未适配当前宿主 SDK。补路由绑定不能修复这些错误。

相关适配见 [#598](https://github.com/larksuite/openclaw-lark/issues/598)、[#605](https://github.com/larksuite/openclaw-lark/issues/605)、[PR #622](https://github.com/larksuite/openclaw-lark/pull/622) 和 [PR #626](https://github.com/larksuite/openclaw-lark/pull/626)。PR 存在不代表已经合并或发布；请核对实际安装版本。

## 2. 检查多 Agent 的默认路由

在显式多 Agent 配置下，只有特定群的绑定，并不等于飞书账户拥有默认 Agent。未命中这些绑定的私聊或其他会话可能报错：

```text
AgentSelectionRequiredError: Multiple agents are configured, but feishu account default routing has no explicit owner.
```

此时飞书 WebSocket 可以正常连接、消息也已经收到，问题发生在选择 Agent 时，而不是飞书凭据或模型速度。

先查看实际 Agent 和绑定，再由操作者决定是否添加账户默认路由：

```sh
openclaw agents list
openclaw agents bindings
```

例如，**仅在确认希望由 `main` 负责 `default` 飞书账户的未匹配消息时**执行：

```sh
openclaw agents bind --agent main --bind feishu:default
openclaw config validate
openclaw gateway restart
```

多账户请替换为实际 account ID，不要把所有账户一律绑定给 `main`。特定群/会话绑定比账户级绑定优先，因此原有 `rich`、`local` 等群路由可以保留。如果有意仅处理显式绑定的会话，也可以不设置默认路由；诊断应提示未匹配消息的行为，而不是自动改变配置。

路由绑定不会代替或放宽飞书配对、`allowFrom`、群白名单及提及策略。不要为了排查路由问题关闭这些限制。

## 3. 做真实收发验收

```sh
openclaw feishu-diagnose
openclaw channels status --probe
openclaw logs --follow
```

`feishu-diagnose` 的账户默认 Agent 路由检查会提示上述缺口。路由检查通过只表示能选择默认 Agent，不保证模型调用或飞书回复发送成功。

在原私聊发送一条无副作用的测试消息，并核对接收、Agent 分发、模型完成和实际回复发送结果。再分别验证已有的特定群路由，避免只测默认 Agent。不要为测试自动重放旧消息或重复执行历史任务。

相关官方说明：[多 Agent 路由](https://docs.openclaw.ai/concepts/multi-agent)、[agents CLI](https://docs.openclaw.ai/cli/agents)、[升级](https://docs.openclaw.ai/install/updating)。
