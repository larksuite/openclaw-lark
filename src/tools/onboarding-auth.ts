/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Onboarding 预授权模块。
 *
 * 配对后自动发起 OAuth Device Flow，引导当前用户完成用户授权。
 *
 * 飞书限制：单次 OAuth 最多 50 个 scope。
 * 超过 50 个时自动分批处理，每批授权完成后自动发起下一批（链式触发）。
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import { getLarkAccount } from '../core/accounts';
import { LarkClient } from '../core/lark-client';
import { getAppGrantedScopes } from '../core/app-scope-checker';
import { executeAuthorize } from './oauth';
import { larkLogger } from '../core/lark-logger';
import { filterSensitiveScopes } from '../core/tool-scopes';
import {
  assertUatAccess,
  UatAccessDeniedError,
  UatAccessUnavailableError,
  UatIdentityRequiredError,
} from '../core/uat-access-guard';
import { sendMessageFeishu } from '../messaging/outbound/send';

const log = larkLogger('tools/onboarding-auth');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SCOPES_PER_BATCH = 100;

// ---------------------------------------------------------------------------
// Trigger onboarding
// ---------------------------------------------------------------------------

/**
 * 配对后触发 onboarding OAuth 授权。
 *
 * 流程：
 *   1. 读取当前应用已开通的 user scope 列表
 *   2. 分批处理（每批最多 50 个），第一批直接发起 OAuth Device Flow
 *   3. 每批授权完成后通过 onAuthComplete 回调自动发起下一批
 */
export async function triggerOnboarding(params: {
  cfg: ClawdbotConfig;
  userOpenId: string;
  accountId: string;
}): Promise<void> {
  const { cfg, userOpenId, accountId } = params;

  const acct = getLarkAccount(cfg, accountId);
  if (!acct.configured) {
    log.warn(`account ${accountId} not configured, skipping`);
    return;
  }

  const sdk = LarkClient.fromAccount(acct).sdk;
  const { appId } = acct;

  // UAT 策略检查：onboarding 是辅助功能，不满足时给用户明确提示，而不是静默跳过。
  try {
    let stateDir: string | undefined;
    try { stateDir = LarkClient.runtime.state.resolveStateDir(); } catch {}
    await assertUatAccess({ account: acct, sdk, userOpenId, stateDir });
  } catch (err) {
    log.info(`UAT access check failed for ${userOpenId}, skipping onboarding: ${err}`);
    let text: string | undefined;
    if (err instanceof UatAccessDeniedError) {
      text = `已完成配对，但当前策略不允许自动发起授权：${err.message}\n如需继续，请联系管理员调整 Feishu UAT 访问策略。`;
    } else if (err instanceof UatAccessUnavailableError) {
      text = `已完成配对，但暂时无法自动发起授权：${err.message}\n请稍后重试，或联系管理员检查应用权限。`;
    } else if (err instanceof UatIdentityRequiredError) {
      text = `已完成配对，但暂时无法自动发起授权：${err.message}`;
    }

    if (text) {
      try {
        await sendMessageFeishu({
          cfg,
          to: userOpenId,
          text,
          accountId,
        });
      } catch (notifyErr) {
        log.warn(`failed to notify onboarding skip for ${userOpenId}: ${notifyErr}`);
      }
    }
    return;
  }

  log.info(`starting OAuth for ${userOpenId}`);

  // 1. 动态获取应用已开通的 user scope 列表
  let allUserScopes: string[];
  try {
    allUserScopes = await getAppGrantedScopes(sdk, appId, 'user');
  } catch (err) {
    log.warn(`failed to get app granted scopes: ${err}`);
    return;
  }

  // 过滤掉敏感 scope
  allUserScopes = filterSensitiveScopes(allUserScopes);

  if (allUserScopes.length === 0) {
    log.info('no user scopes configured, skipping');
    return;
  }

  // 4. 分批
  const batches: string[][] = [];
  for (let i = 0; i < allUserScopes.length; i += MAX_SCOPES_PER_BATCH) {
    batches.push(allUserScopes.slice(i, i + MAX_SCOPES_PER_BATCH));
  }

  log.info(`${allUserScopes.length} user scopes, ${batches.length} batch(es)`);

  // 5. 链式发起授权（第一批同步发起，后续批次由 onAuthComplete 回调触发）
  const startBatch = async (batchIndex: number): Promise<void> => {
    if (batchIndex >= batches.length) {
      log.info('all batches completed');
      return;
    }

    const batch = batches[batchIndex];
    const scope = batch.join(' ');

    let batchInfo = '';
    if (batches.length > 1) {
      batchInfo =
        `\n\n📋 授权进度：第 ${batchIndex + 1}/${batches.length} 批` +
        `（本批 ${batch.length} 个权限，共 ${allUserScopes.length} 个）`;
      if (batchIndex < batches.length - 1) {
        batchInfo += `\n授权完成后将自动发起下一批。`;
      } else {
        batchInfo += `\n这是最后一批，授权完成后即可使用所有功能。`;
      }
    }

    const ticket = {
      messageId: `onboarding:${Date.now()}`,
      chatId: userOpenId,
      accountId,
      startTime: Date.now(),
      senderOpenId: userOpenId,
      chatType: 'p2p' as const,
    };

    log.info(`starting batch ${batchIndex + 1}/${batches.length}, scopes=${batch.length}`);

    try {
      await executeAuthorize({
        account: acct,
        senderOpenId: userOpenId,
        scope,
        isBatchAuth: true,
        totalAppScopes: allUserScopes.length,
        alreadyGranted: batchIndex * MAX_SCOPES_PER_BATCH,
        batchInfo,
        skipSyntheticMessage: true,
        cfg,
        ticket,
        onAuthComplete: async () => {
          log.info(`batch ${batchIndex + 1}/${batches.length} auth completed`);
          await startBatch(batchIndex + 1);
        },
      });
    } catch (err) {
      log.error(`batch ${batchIndex + 1} failed: ${err}`);
    }
  };

  await startBatch(0);
}
