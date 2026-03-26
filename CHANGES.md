# Fix: Cron jobs in isolated session fail with "appId and appSecret are required"

## Root Cause

`getResolvedConfig()` in `src/core/lark-client.ts` called
`LarkClient.runtime.config.loadConfig()` and returned its result directly.
In isolated session contexts (cron jobs with `sessionTarget: isolated`),
`loadConfig()` **succeeds but returns an empty config** — it doesn't throw,
so the existing `catch` fallback was never reached. Downstream helpers
received `{}` as the config, could not find `channels.feishu` credentials,
and threw `LarkClient[default]: appId and appSecret are required`.

## Fix

After calling `loadConfig()`, check whether the returned config actually
contains `channels.feishu`. If not, fall back to `LarkClient.globalConfig`
(set at monitor startup with the full config) and then to the provided
`fallback` param. The `catch` branch for a throwing runtime is unchanged.

## Files Changed

- `src/core/lark-client.ts` — updated `getResolvedConfig` (6 lines)
- `tests/get-resolved-config-isolated.test.ts` — 4 new regression tests

## Verification

```
pnpm test      → 28 passed (6 test files)
pnpm lint      → exit 0
pnpm typecheck → exit 0
```

---

## Draft PR Body

### Problem

Cron jobs running with `sessionTarget: isolated` (the default) could not
send messages via Feishu:

```
Error: LarkClient[default]: appId and appSecret are required
```

Even though `channels.feishu.accounts.main` was correctly set in
`openclaw.json`, the plugin reported missing credentials.

### Root Cause

`getResolvedConfig()` always returned the result of
`LarkClient.runtime.config.loadConfig()` without checking whether the
result actually contained Feishu credentials. In isolated session contexts
`loadConfig()` returns a stripped/empty config object, so credentials were
never found.

### Change

`getResolvedConfig` now falls through a three-level priority chain:

1. **Live config** — `loadConfig()` result, only if `channels.feishu` is
   present (normal interactive sessions).
2. **Global config** — `LarkClient.globalConfig` set at monitor startup,
   used when the live config is empty (isolated sessions / cron jobs).
3. **Fallback** — the config snapshot captured at plugin registration time,
   used when neither of the above is available (early startup).

### Testing

Four regression tests added in
`tests/get-resolved-config-isolated.test.ts` covering all three fallback
branches and the throw-on-uninitialized path.
