/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Feishu / Lark SDK client management.
 *
 * Provides `LarkClient` — a unified manager for Lark SDK client instances,
 * WebSocket connections, EventDispatcher lifecycle, and bot identity.
 *
 * Consumers obtain instances via factory methods:
 *   - `LarkClient.fromCfg(cfg, accountId)` — resolve account from config
 *   - `LarkClient.fromAccount(account)` — from a pre-resolved account
 *   - `LarkClient.fromCredentials(credentials)` — ephemeral instance (not cached)
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import * as Lark from '@larksuiteoapi/node-sdk';

import type { ClawdbotConfig, PluginRuntime } from 'openclaw/plugin-sdk';
import type { LarkBrand, LarkAccount, FeishuProbeResult } from './types';
import { getLarkAccount } from './accounts';
// NOTE: clearUserNameCache is lazy-imported in clearCache() to break a
// circular dependency with user-name-cache.ts (which imports LarkClient).
import { clearChatInfoCache } from './chat-info-cache';
import { getUserAgent } from './version';
import { larkLogger } from './lark-logger';

const log = larkLogger('core/lark-client');
import type { MessageDedup } from '../messaging/inbound/dedup';

// ---------------------------------------------------------------------------
// 注入 User-Agent 到所有飞书 SDK 请求
// ---------------------------------------------------------------------------

const GLOBAL_LARK_USER_AGENT_KEY = 'LARK_USER_AGENT';

function installGlobalUserAgent(): void {
  // node-sdk 内置拦截器最终会读取 global.LARK_USER_AGENT 并覆盖 User-Agent
  (globalThis as Record<string, unknown>)[GLOBAL_LARK_USER_AGENT_KEY] = getUserAgent();
}

installGlobalUserAgent();
Lark.defaultHttpInstance.interceptors.request.handlers = [];
// 使用 interceptors 在所有 HTTP 请求中注入 User-Agent header
Lark.defaultHttpInstance.interceptors.request.use(
  (req) => {
    if (req.headers) {
      req.headers['User-Agent'] = getUserAgent();
    }
    return req;
  },
  undefined,
  { synchronous: true },
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
/** Credential set accepted by the ephemeral `fromCredentials` factory. */
export interface LarkClientCredentials {
  accountId?: string;
  appId?: string;
  appSecret?: string;
  brand?: LarkBrand;
}

// ---------------------------------------------------------------------------
// Brand → SDK domain
// ---------------------------------------------------------------------------

const BRAND_TO_DOMAIN: Record<string, Lark.Domain> = {
  feishu: Lark.Domain.Feishu,
  lark: Lark.Domain.Lark,
};

/** Map a `LarkBrand` to the SDK `domain` parameter. */
function resolveBrand(brand: LarkBrand | undefined): Lark.Domain | string {
  return BRAND_TO_DOMAIN[brand ?? 'feishu'] ?? brand!.replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// LarkClient
// ---------------------------------------------------------------------------

/** Instance cache keyed by accountId. */
const cache = new Map<string, LarkClient>();

export class LarkClient {
  readonly account: LarkAccount;

  private _sdk: Lark.Client | null = null;
  private _wsClient: Lark.WSClient | null = null;
  private _botOpenId: string | undefined;
  private _botName: string | undefined;
  private _lastProbeResult: FeishuProbeResult | null = null;
  private _lastProbeAt = 0;

  /** Attached message deduplicator — disposed together with the client. */
  messageDedup: MessageDedup | null = null;

  // ---- Plugin runtime (singleton) ------------------------------------------

  private static _runtime: PluginRuntime | null = null;

  /** Persist the runtime instance for later retrieval (activate 阶段调用一次). */
  static setRuntime(runtime: PluginRuntime): void {
    LarkClient._runtime = runtime;
  }

  /** Retrieve the stored runtime instance. Throws if not yet initialised. */
  static get runtime(): PluginRuntime {
    if (!LarkClient._runtime) {
      throw new Error(
        'Feishu plugin runtime has not been initialised. ' +
          'Ensure LarkClient.setRuntime() is called during plugin activation.',
      );
    }
    return LarkClient._runtime;
  }

  // ---- Global config (singleton) -------------------------------------------
  //
  // Plugin commands receive an account-scoped config (channels.feishu replaced
  // with the merged per-account config, `accounts` map stripped).  Commands
  // that need cross-account visibility (e.g. doctor, diagnose) read the
  // original global config from here.

  private static _globalConfig: ClawdbotConfig | null = null;

  /** Store the original global config (called during monitor startup). */
  static setGlobalConfig(cfg: ClawdbotConfig): void {
    LarkClient._globalConfig = cfg;
  }

  /** Retrieve the stored global config, or `null` if not yet set. */
  static get globalConfig(): ClawdbotConfig | null {
    return LarkClient._globalConfig;
  }

  // --------------------------------------------------------------------------

  private constructor(account: LarkAccount) {
    this.account = account;
  }

  /** Shorthand for `this.account.accountId`. */
  get accountId(): string {
    return this.account.accountId;
  }

  // ---- Static factory / cache ------------------------------------------------

  /** Resolve account from config and return a cached `LarkClient`. */
  static fromCfg(cfg: ClawdbotConfig, accountId?: string): LarkClient {
    return LarkClient.fromAccount(getLarkAccount(cfg, accountId));
  }

  /**
   * Get (or create) a cached `LarkClient` for the given account.
   * If the cached instance has stale credentials it is replaced.
   */
  static fromAccount(account: LarkAccount): LarkClient {
    const existing = cache.get(account.accountId);
    if (existing && existing.account.appId === account.appId && existing.account.appSecret === account.appSecret) {
      return existing;
    }
    // Credentials changed — tear down the stale instance before replacing it.
    if (existing) {
      log.info(`credentials changed, disposing stale instance`, { accountId: account.accountId });
      existing.dispose();
    }
    const instance = new LarkClient(account);
    cache.set(account.accountId, instance);
    return instance;
  }

  /**
   * Create an ephemeral `LarkClient` from bare credentials.
   * The instance is **not** added to the global cache — suitable for
   * one-off probe / diagnose calls that should not pollute account state.
   */
  static fromCredentials(credentials: LarkClientCredentials): LarkClient {
    const base = {
      accountId: credentials.accountId ?? 'default',
      enabled: true as const,
      brand: credentials.brand ?? ('feishu' as const),
      config: {} as any,
    };

    const account: LarkAccount =
      credentials.appId && credentials.appSecret
        ? { ...base, configured: true as const, appId: credentials.appId, appSecret: credentials.appSecret }
        : { ...base, configured: false as const, appId: credentials.appId, appSecret: credentials.appSecret };

    return new LarkClient(account);
  }

  /** Look up a cached instance by accountId. */
  static get(accountId: string): LarkClient | null {
    return cache.get(accountId) ?? null;
  }

  /**
   * Dispose one or all cached instances.
   * With `accountId` — dispose that single instance.
   * Without — dispose every cached instance and clear the cache.
   */
  static async clearCache(accountId?: string): Promise<void> {
    const {clearUserNameCache} = await import('../messaging/inbound/user-name-cache');
    if (accountId !== undefined) {
      cache.get(accountId)?.dispose();
      clearUserNameCache(accountId);
      clearChatInfoCache(accountId);
    } else {
      for (const inst of cache.values()) inst.dispose();
      clearUserNameCache();
      clearChatInfoCache();
    }
  }

  // ---- SDK client (lazy) -----------------------------------------------------

  /** Lazily-created Lark SDK client. */
  get sdk(): Lark.Client {
    if (!this._sdk) {
      const { appId, appSecret } = this.requireCredentials();
      this._sdk = new Lark.Client({
        appId,
        appSecret,
        appType: Lark.AppType.SelfBuild,
        domain: resolveBrand(this.account.brand),
      });
    }
    return this._sdk;
  }

  // ---- Bot identity ----------------------------------------------------------

  /**
   * Probe bot identity via the `bot/v3/info` API.
   * Results are cached on the instance for subsequent access via
   * `botOpenId` / `botName`.
   */
  async probe(opts?: { maxAgeMs?: number }): Promise<FeishuProbeResult> {
    const maxAge = opts?.maxAgeMs ?? 0;

    if (maxAge > 0 && this._lastProbeResult && Date.now() - this._lastProbeAt < maxAge) {
      return this._lastProbeResult;
    }

    if (!this.account.appId || !this.account.appSecret) {
      return { ok: false, error: 'missing credentials (appId, appSecret)' };
    }

    try {
      const res = await (this.sdk as any).request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
        data: {},
      });

      if (res.code !== 0) {
        const result: FeishuProbeResult = {
          ok: false,
          appId: this.account.appId,
          error: `API error: ${res.msg || `code ${res.code}`}`,
        };
        this._lastProbeResult = result;
        this._lastProbeAt = Date.now();
        return result;
      }

      const bot = res.bot || res.data?.bot;
      this._botOpenId = bot?.open_id;
      this._botName = bot?.bot_name;

      const result: FeishuProbeResult = {
        ok: true,
        appId: this.account.appId,
        botName: this._botName,
        botOpenId: this._botOpenId,
      };
      this._lastProbeResult = result;
      this._lastProbeAt = Date.now();
      return result;
    } catch (err) {
      const result: FeishuProbeResult = {
        ok: false,
        appId: this.account.appId,
        error: err instanceof Error ? err.message : String(err),
      };
      this._lastProbeResult = result;
      this._lastProbeAt = Date.now();
      return result;
    }
  }

  /** Cached bot open_id (available after `probe()` or `startWS()`). */
  get botOpenId(): string | undefined {
    return this._botOpenId;
  }

  /** Cached bot name (available after `probe()` or `startWS()`). */
  get botName(): string | undefined {
    return this._botName;
  }

  // ---- WebSocket lifecycle ---------------------------------------------------

  /**
   * Start WebSocket event monitoring.
   *
   * Flow: probe bot identity → EventDispatcher → WSClient → start.
   * The returned Promise resolves when `abortSignal` fires.
   */
  async startWS(opts: {
    handlers: Record<string, (data: unknown) => Promise<void>>;
    abortSignal?: AbortSignal;
    autoProbe?: boolean;
  }): Promise<void> {
    const { handlers, abortSignal, autoProbe = true } = opts;

    if (autoProbe) await this.probe();

    const dispatcher = new Lark.EventDispatcher({
      encryptKey: this.account.encryptKey ?? '',
      verificationToken: this.account.verificationToken ?? '',
    });
    dispatcher.register(handlers as any);

    const { appId, appSecret } = this.requireCredentials();
    // Close any existing WSClient before creating a new one to prevent
    // orphaned connections when startWS is called multiple times.
    if (this._wsClient) {
      log.warn(`closing previous WSClient before reconnect`, { accountId: this.accountId });
      try {
        this._wsClient.close({ force: true });
      } catch {
        // Ignore — the old client may already be torn down.
      }
      this._wsClient = null;
    }

    this._wsClient = new Lark.WSClient({
      appId,
      appSecret,
      domain: resolveBrand(this.account.brand),
      loggerLevel: Lark.LoggerLevel.info,
    });

    // SDK 的 handleEventData 只处理 type="event"，card action 回调是 type="card" 会被丢弃。
    // 打 patch 将 "card" 类型消息改成 "event" 后交给原 handler，让 EventDispatcher 正常路由。
    const wsClientAny = this._wsClient as any;
    const origHandleEventData = wsClientAny.handleEventData.bind(wsClientAny);
    wsClientAny.handleEventData = (data: any) => {
      const msgType = data.headers?.find?.((h: any) => h.key === 'type')?.value;
      if (msgType === 'card') {
        const patchedData = {
          ...data,
          headers: data.headers.map((h: any) => (h.key === 'type' ? { ...h, value: 'event' } : h)),
        };
        return origHandleEventData(patchedData);
      }
      return origHandleEventData(data);
    };

    await this.waitForAbort(dispatcher, abortSignal);
  }

  /** Whether a WebSocket client is currently active. */
  get wsConnected(): boolean {
    return this._wsClient !== null;
  }

  /** Disconnect WebSocket but keep instance in cache. */
  disconnect(): void {
    if (this._wsClient) {
      log.info(`disconnecting WebSocket`, { accountId: this.accountId });
      try {
        this._wsClient.close({ force: true });
      } catch {
        // Ignore errors during close — the client may already be torn down.
      }
    }
    this._wsClient = null;
    if (this.messageDedup) {
      log.info(`disposing message dedup`, { accountId: this.accountId, size: this.messageDedup.size });
      this.messageDedup.dispose();
      this.messageDedup = null;
    }
  }

  /** Disconnect + remove from cache. */
  dispose(): void {
    this.disconnect();
    cache.delete(this.accountId);
  }

  // ---- Private helpers -------------------------------------------------------

  /** Assert credentials exist or throw. */
  private requireCredentials(): { appId: string; appSecret: string } {
    const appId = this.account.appId;
    const appSecret = this.account.appSecret;
    if (!appId || !appSecret) {
      throw new Error(`LarkClient[${this.accountId}]: appId and appSecret are required`);
    }
    return { appId, appSecret };
  }

  /**
   * Start the WSClient and return a promise that resolves when the
   * abort signal fires (or immediately if already aborted).
   */
  private waitForAbort(dispatcher: Lark.EventDispatcher, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        this.disconnect();
        return resolve();
      }

      signal?.addEventListener(
        'abort',
        () => {
          this.disconnect();
          resolve();
        },
        { once: true },
      );

      try {
        void this._wsClient!.start({ eventDispatcher: dispatcher });
      } catch (err) {
        this.disconnect();
        reject(err);
      }
    });
  }
}
