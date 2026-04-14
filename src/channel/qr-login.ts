/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Feishu/Lark QR onboarding for both local CLI and remote dashboard flows.
 *
 * This mirrors the official onboarding tool's registration API:
 *   1. init   -> check supported auth methods
 *   2. begin  -> create a registration session and QR/login URL
 *   3. poll   -> wait until the user finishes scan + app creation
 *
 * On success, the new bot credentials are written back into OpenClaw config
 * so the gateway can immediately start the Feishu channel.
 */

import QRCode from 'qrcode';
import type { ClawdbotConfig, RuntimeEnv } from 'openclaw/plugin-sdk';
import { DEFAULT_ACCOUNT_ID } from 'openclaw/plugin-sdk/account-id';
import { loadConfig, writeConfigFile } from 'openclaw/plugin-sdk/config-runtime';
import { getLarkAccount } from '../core/accounts';
import { accountsDomain } from '../core/domains';
import { feishuFetch } from '../core/feishu-fetch';
import { LarkClient } from '../core/lark-client';
import type { LarkBrand } from '../core/types';
import { applyAccountConfig } from './config-adapter';

const REGISTRATION_PATH = '/oauth/v1/app/registration';
const REGISTRATION_ARCHETYPE = 'PersonalAgent';
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MAX_POLL_INTERVAL_MS = 60_000;

interface RegistrationInitResponse {
  supported_auth_methods?: string[];
}

interface RegistrationBeginResponse {
  device_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  interval?: number;
  expire_in?: number;
  error?: string;
  error_description?: string;
}

interface RegistrationPollResponse {
  client_id?: string;
  client_secret?: string;
  error?: string;
  error_description?: string;
  user_info?: {
    open_id?: string;
    tenant_brand?: string;
  };
}

interface FeishuQrLoginSuccess {
  appId: string;
  appSecret: string;
  brand: LarkBrand;
  userOpenId?: string;
  hasUserInfo: boolean;
}

interface FeishuQrLoginSession {
  accountId: string;
  brand: LarkBrand;
  verificationUrl: string;
  qrDataUrl: string;
  deviceCode: string;
  pollIntervalMs: number;
  expiresAt: number;
  state: 'pending' | 'connected' | 'failed';
  success?: FeishuQrLoginSuccess;
  failureMessage?: string;
  persisted: boolean;
}

interface FeishuQrLoginStartResult {
  qrDataUrl?: string;
  message: string;
}

interface FeishuQrLoginWaitResult {
  connected: boolean;
  message: string;
}

const sessions = new Map<string, FeishuQrLoginSession>();

function normalizeAccountId(accountId?: string | null): string {
  return accountId?.trim() || DEFAULT_ACCOUNT_ID;
}

function registrationUrl(brand: LarkBrand): string {
  return `${accountsDomain(brand)}${REGISTRATION_PATH}`;
}

async function postRegistrationJson(
  brand: LarkBrand,
  action: 'init' | 'begin' | 'poll',
  body: Record<string, string>,
  opts?: { tolerateErrors?: boolean },
): Promise<Record<string, unknown>> {
  const resp = await feishuFetch(registrationUrl(brand), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ action, ...body }).toString(),
  });

  const text = await resp.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Feishu registration ${action} failed: HTTP ${resp.status}`);
  }

  if (!resp.ok && !opts?.tolerateErrors) {
    const detail = (data.error_description as string) ?? (data.error as string) ?? `HTTP ${resp.status}`;
    throw new Error(`Feishu registration ${action} failed: ${detail}`);
  }

  return data;
}

async function initRegistration(brand: LarkBrand): Promise<RegistrationInitResponse> {
  return (await postRegistrationJson(brand, 'init', {})) as RegistrationInitResponse;
}

async function beginRegistration(brand: LarkBrand): Promise<RegistrationBeginResponse> {
  return (await postRegistrationJson(brand, 'begin', {
    archetype: REGISTRATION_ARCHETYPE,
    auth_method: 'client_secret',
    request_user_info: 'open_id',
  })) as RegistrationBeginResponse;
}

async function pollRegistration(brand: LarkBrand, deviceCode: string): Promise<RegistrationPollResponse> {
  return (await postRegistrationJson(
    brand,
    'poll',
    { device_code: deviceCode },
    { tolerateErrors: true },
  )) as RegistrationPollResponse;
}

function appendOnboardSource(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('from', 'onboard');
  return parsed.toString();
}

function toStringList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((value) => String(value).trim()).filter(Boolean);
}

export function applyFeishuOnboardingConfig(
  cfg: ClawdbotConfig,
  accountId: string,
  success: FeishuQrLoginSuccess,
): ClawdbotConfig {
  const current = getLarkAccount(cfg, accountId).config;

  let next = applyAccountConfig(cfg, accountId, {
    enabled: true,
    appId: success.appId,
    appSecret: success.appSecret,
    domain: success.brand,
    connectionMode: current.connectionMode ?? 'websocket',
  });

  if (success.userOpenId) {
    const allowFrom = new Set([...toStringList(current.allowFrom), success.userOpenId]);
    next = applyAccountConfig(next, accountId, {
      dmPolicy: 'allowlist',
      allowFrom: [...allowFrom],
    });

    if (!current.groupPolicy) {
      const groupAllowFrom = new Set([...toStringList(current.groupAllowFrom), success.userOpenId]);
      next = applyAccountConfig(next, accountId, {
        groupPolicy: 'allowlist',
        groupAllowFrom: [...groupAllowFrom],
        groups: current.groups ?? { '*': { enabled: true } },
      });
    }
  } else if (success.hasUserInfo) {
    next = applyAccountConfig(next, accountId, {
      dmPolicy: current.dmPolicy ?? 'open',
    });
  } else if (!current.dmPolicy) {
    next = applyAccountConfig(next, accountId, {
      dmPolicy: 'pairing',
    });
  }

  if (!getLarkAccount(next, accountId).config.groupPolicy) {
    next = applyAccountConfig(next, accountId, { groupPolicy: 'open' });
  }

  return next;
}

function buildStartMessage(session: FeishuQrLoginSession): string {
  return [
    'Scan the QR code with Feishu/Lark to create and pair a new bot.',
    `Open this link if QR scanning is unavailable: ${session.verificationUrl}`,
    `Account: ${session.accountId}`,
  ].join('\n');
}

function buildPendingMessage(session: FeishuQrLoginSession): string {
  return ['Waiting for Feishu/Lark onboarding to complete.', `You can still open: ${session.verificationUrl}`].join(
    '\n',
  );
}

function buildSuccessMessage(session: FeishuQrLoginSession): string {
  const details = [
    `Feishu bot created and paired successfully for account ${session.accountId}.`,
    `App ID: ${session.success?.appId}`,
    `Domain: ${session.success?.brand}`,
  ];
  if (session.success?.userOpenId) {
    details.push(`Owner open_id added to allowlists: ${session.success.userOpenId}`);
  }
  return details.join('\n');
}

async function persistConnectedSession(session: FeishuQrLoginSession): Promise<void> {
  if (session.persisted || !session.success) return;

  const currentConfig = loadConfig() as ClawdbotConfig;
  const nextConfig = applyFeishuOnboardingConfig(currentConfig, session.accountId, session.success);

  await writeConfigFile(nextConfig);
  await LarkClient.clearCache(session.accountId);
  session.persisted = true;
}

function resolveInitialBrand(accountId: string): LarkBrand {
  try {
    return getLarkAccount(loadConfig() as ClawdbotConfig, accountId).brand ?? 'feishu';
  } catch {
    return 'feishu';
  }
}

async function createSession(accountId: string): Promise<FeishuQrLoginSession> {
  const initialBrand = resolveInitialBrand(accountId);
  const init = await initRegistration(initialBrand);
  const supportedMethods = Array.isArray(init.supported_auth_methods) ? init.supported_auth_methods : [];
  if (!supportedMethods.includes('client_secret')) {
    throw new Error('Current Feishu environment does not support client_secret onboarding');
  }

  const begin = await beginRegistration(initialBrand);
  const verificationUrlRaw = begin.verification_uri_complete ?? begin.verification_uri;
  const deviceCode = begin.device_code;
  if (!verificationUrlRaw || !deviceCode) {
    throw new Error(
      `Feishu onboarding did not return a usable QR session (${begin.error_description ?? begin.error ?? 'missing fields'})`,
    );
  }

  const verificationUrl = appendOnboardSource(verificationUrlRaw);
  const qrDataUrl = await QRCode.toDataURL(verificationUrl, { margin: 1 });
  return {
    accountId,
    brand: initialBrand,
    verificationUrl,
    qrDataUrl,
    deviceCode,
    pollIntervalMs: Math.max(0, (begin.interval ?? 5) * 1000),
    expiresAt: Date.now() + Math.max(1, begin.expire_in ?? 600) * 1000,
    state: 'pending',
    persisted: false,
  };
}

export async function startFeishuQrLogin(
  params: {
    accountId?: string | null;
    force?: boolean;
  } = {},
): Promise<FeishuQrLoginStartResult> {
  const accountId = normalizeAccountId(params.accountId);
  const existing = sessions.get(accountId);
  if (existing && existing.state === 'pending' && !params.force && Date.now() < existing.expiresAt) {
    return {
      qrDataUrl: existing.qrDataUrl,
      message: buildStartMessage(existing),
    };
  }

  const session = await createSession(accountId);
  sessions.set(accountId, session);
  return {
    qrDataUrl: session.qrDataUrl,
    message: buildStartMessage(session),
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForFeishuQrLogin(
  params: {
    accountId?: string | null;
    timeoutMs?: number;
  } = {},
): Promise<FeishuQrLoginWaitResult> {
  const accountId = normalizeAccountId(params.accountId);
  const session = sessions.get(accountId);
  if (!session) {
    return {
      connected: false,
      message: `No active Feishu onboarding session for account ${accountId}. Start a new login first.`,
    };
  }

  if (session.state === 'connected') {
    await persistConnectedSession(session);
    return { connected: true, message: buildSuccessMessage(session) };
  }

  if (session.state === 'failed') {
    return { connected: false, message: session.failureMessage ?? 'Feishu onboarding failed.' };
  }

  const timeoutMs = Math.max(0, params.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
  const deadline = Math.min(Date.now() + timeoutMs, session.expiresAt);

  while (Date.now() <= deadline) {
    const poll = await pollRegistration(session.brand, session.deviceCode);
    const pollBrand = poll.user_info?.tenant_brand;
    if (pollBrand === 'lark') {
      session.brand = 'lark';
    }

    if (poll.client_id && poll.client_secret) {
      session.state = 'connected';
      session.success = {
        appId: poll.client_id,
        appSecret: poll.client_secret,
        brand: session.brand,
        userOpenId: poll.user_info?.open_id,
        hasUserInfo: Boolean(poll.user_info),
      };
      await persistConnectedSession(session);
      return { connected: true, message: buildSuccessMessage(session) };
    }

    switch (poll.error) {
      case undefined:
      case 'authorization_pending':
        break;
      case 'slow_down':
        session.pollIntervalMs = Math.min(session.pollIntervalMs + 5_000, MAX_POLL_INTERVAL_MS);
        break;
      case 'access_denied':
        session.state = 'failed';
        session.failureMessage = 'Feishu onboarding was denied by the user.';
        return { connected: false, message: session.failureMessage };
      case 'expired_token':
        session.state = 'failed';
        session.failureMessage = 'Feishu onboarding session expired. Start a new login.';
        return { connected: false, message: session.failureMessage };
      default:
        session.state = 'failed';
        session.failureMessage = `Feishu onboarding failed: ${poll.error_description ?? poll.error}`;
        return { connected: false, message: session.failureMessage };
    }

    if (Date.now() >= deadline) break;
    if (session.pollIntervalMs > 0) {
      await sleep(Math.min(session.pollIntervalMs, Math.max(0, deadline - Date.now())));
    }
  }

  if (Date.now() >= session.expiresAt) {
    session.state = 'failed';
    session.failureMessage = 'Feishu onboarding session expired. Start a new login.';
    return { connected: false, message: session.failureMessage };
  }

  return {
    connected: false,
    message: buildPendingMessage(session),
  };
}

export async function runFeishuQrLoginCli(params: {
  accountId?: string | null;
  runtime: RuntimeEnv;
  force?: boolean;
}): Promise<void> {
  const accountId = normalizeAccountId(params.accountId);
  await startFeishuQrLogin({
    accountId,
    force: params.force,
  });
  const session = sessions.get(accountId);
  if (!session) {
    throw new Error('Failed to initialize Feishu onboarding session');
  }

  params.runtime.log('Scan with Feishu/Lark to configure your bot:');
  params.runtime.log(session.verificationUrl);

  const terminalQr = await QRCode.toString(session.verificationUrl, { type: 'terminal', small: true });
  params.runtime.log(terminalQr);

  const waited = await waitForFeishuQrLogin({
    accountId,
    timeoutMs: Math.max(0, session.expiresAt - Date.now()),
  });

  if (!waited.connected) {
    throw new Error(waited.message);
  }

  params.runtime.log(waited.message);
}

export function _resetFeishuQrLoginSessions(): void {
  sessions.clear();
}
