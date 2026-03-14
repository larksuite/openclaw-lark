/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * oauth-cards.ts — OAuth 授权卡片构建函数。
 *
 * 从 oauth.ts 提取的纯 UI 函数，与 OAuth 业务流程解耦。
 * 卡片使用 v2 JSON 结构 + i18n_content 支持多语言。
 */

import type { LarkBrand } from '../core/types';
import { applinkDomain } from '../core/domains';

// ---------------------------------------------------------------------------
// i18n config helper
// ---------------------------------------------------------------------------

type Locale = 'zh_cn' | 'en_us';

/** v2 卡片 i18n 配置，注入到 config 中 */
const I18N_CONFIG = {
  update_multi: true,
  locales: ['zh_cn', 'en_us'] as Locale[],
};

// ---------------------------------------------------------------------------
// i18n texts
// ---------------------------------------------------------------------------

const CARD_TEXTS = {
  zh_cn: {
    authRequired: '请授权以继续当前操作',
    goAuth: '前往授权',
    expiresHint: (min: number) =>
      `<font color='grey'>授权链接将在 ${min} 分钟后失效，届时需重新发起</font>`,
    batchAuthHint:
      "<font color='grey'>💡如果你希望一次性授予所有插件所需要的权限，可以告诉我「授予所有用户权限」，我会协助你完成。</font>",

    batchScopeMsg: (count: number, total: number, granted: number) =>
      `应用需要授权 **${count}** 个用户权限（共 ${total} 个，已授权 ${granted} 个）。`,
    scopePreviewLabel: '**将要授权的权限**',
    scopeListLabel: '**将要授权的权限列表**',
    scopeDesc: '授权后，应用将能够以你的身份执行相关操作。',
    requiredScopes: '所需权限：',

    authSuccess: '授权成功',
    authSuccessBody: (brandName: string) =>
      `你的${brandName}账号已成功授权，正在为你继续执行操作。\n\n` +
      "<font color='grey'>如需撤销授权，可随时告诉我。</font>",

    authIncomplete: '授权未完成',
    authExpiredBody: '授权链接已过期，请重新发起授权。',

    authMismatchTitle: '授权失败，操作账号与发起账号不一致',
    authMismatchBody: (brandName: string) =>
      `检测到当前进行授权操作的${brandName}账号与发起授权请求的账号不一致。为保障数据安全，本次授权已被拒绝。\n\n` +
      "<font color='grey'>请授权请求的发起人使用其账号，点击授权链接完成授权。</font>",
  },
  en_us: {
    authRequired: 'Authorize to continue',
    goAuth: 'Authorize Now',
    expiresHint: (min: number) =>
      `<font color='grey'>This link will time out in ${min} minutes, so you'll need a new one if it expires.</font>`,
    batchAuthHint:
      "<font color='grey'>💡 If you'd like to grant all permissions at once, just say \"Authorize all\", and I'll take care of it.</font>",

    batchScopeMsg: (count: number, total: number, granted: number) =>
      `The app requires ${count} additional user token permissions (${granted} of ${total} granted).`,
    scopePreviewLabel: '**Permissions to authorize**',
    scopeListLabel: '**Permissions to authorize**',
    scopeDesc: 'Once authorized, the app can perform actions on your behalf.',
    requiredScopes: 'Required permissions:',

    authSuccess: 'Authorized',
    authSuccessBody: (brandName: string) =>
      `${brandName} account authorized. Continuing with your request.\n\n` +
      "<font color='grey'>Let me know if you ever need to revoke the permissions.</font>",

    authIncomplete: 'Authorization incomplete',
    authExpiredBody: 'The link is no longer active. Please restart the process.',

    authMismatchTitle: 'Authorization failed: Account mismatch',
    authMismatchBody: (brandName: string) =>
      `The ${brandName} account used for authorization does not match the account that initiated the request. To protect your data, this request has been denied.\n\n` +
      "<font color='grey'>Only the person who started this request can authorize it using their account.</font>",
  },
};

/** 构造 i18n_content 对象（双语） */
function i18nContent(zh: string, en: string): Record<Locale, string> {
  return { zh_cn: zh, en_us: en };
}

/** 构造带 i18n_content 的 plain_text（默认语言为英文） */
function i18nPlainText(zh: string, en: string) {
  return { tag: 'plain_text' as const, content: en, i18n_content: i18nContent(zh, en) };
}


// ---------------------------------------------------------------------------
// Card builders
// ---------------------------------------------------------------------------

export function buildAuthCard(params: {
  verificationUriComplete: string;
  expiresMin: number;
  scope?: string;
  isBatchAuth?: boolean;
  totalAppScopes?: number;
  alreadyGranted?: number;
  batchInfo?: string;
  filteredScopes?: string[]; // 被过滤的 scope（应用未开通）
  appId?: string; // 用于生成权限管理链接
  showBatchAuthHint?: boolean; // 仅 auto-auth 流程展示批量授权提示
  brand?: LarkBrand; // 品牌（feishu / lark），用于 URL 域名适配
}): Record<string, unknown> {
  const {
    verificationUriComplete,
    expiresMin,
    scope,
    isBatchAuth,
    totalAppScopes,
    alreadyGranted,
    batchInfo,
    filteredScopes,
    appId,
    showBatchAuthHint,
    brand,
  } = params;
  const inAppUrl = toInAppWebUrl(verificationUriComplete, brand);
  const multiUrl = {
    url: inAppUrl,
    pc_url: inAppUrl,
    android_url: inAppUrl,
    ios_url: inAppUrl,
  };

  const scopeParams = { scope, isBatchAuth, totalAppScopes, alreadyGranted, batchInfo, filteredScopes, appId };
  const scopeDescZh = formatScopeDescription('zh_cn', scopeParams);
  const scopeDescEn = formatScopeDescription('en_us', scopeParams);

  const zhT = CARD_TEXTS.zh_cn;
  const enT = CARD_TEXTS.en_us;

  const elements: Record<string, unknown>[] = [
    // 授权说明
    {
      tag: 'markdown',
      content: scopeDescEn,
      i18n_content: i18nContent(scopeDescZh, scopeDescEn),
      text_size: 'normal',
    },
    // 授权按钮（small，靠右）
    {
      tag: 'column_set',
      flex_mode: 'none',
      horizontal_align: 'right',
      columns: [
        {
          tag: 'column',
          width: 'auto',
          elements: [
            {
              tag: 'button',
              text: i18nPlainText(zhT.goAuth, enT.goAuth),
              type: 'primary',
              size: 'medium',
              multi_url: multiUrl,
            },
          ],
        },
      ],
    },
    // 失效时间提醒
    {
      tag: 'markdown',
      content: enT.expiresHint(expiresMin),
      i18n_content: i18nContent(zhT.expiresHint(expiresMin), enT.expiresHint(expiresMin)),
      text_size: 'notation',
    },
    // 批量授权提示（仅 auto-auth 流程展示）
    ...(showBatchAuthHint
      ? [
          {
            tag: 'markdown',
            content: enT.batchAuthHint,
            i18n_content: i18nContent(zhT.batchAuthHint, enT.batchAuthHint),
            text_size: 'notation',
          },
        ]
      : []),
  ];

  return {
    schema: '2.0',
    config: {
      wide_screen_mode: false,
      ...I18N_CONFIG,
      style: {
        color: {
          'light-yellow-bg': {
            light_mode: 'rgba(255, 214, 102, 0.12)',
            dark_mode: 'rgba(255, 214, 102, 0.08)',
          },
        },
      },
    },
    header: {
      title: i18nPlainText(zhT.authRequired, enT.authRequired),
      subtitle: {
        tag: 'plain_text',
        content: '',
      },
      template: 'blue',
      padding: '12px 12px 12px 12px',
      icon: {
        tag: 'standard_icon',
        token: 'lock-chat_filled',
      },
    },
    body: { elements },
  };
}

/** scope 字符串 → 可读描述（支持多语言） */
export function formatScopeDescription(
  locale: Locale,
  params: {
    scope?: string;
    isBatchAuth?: boolean;
    totalAppScopes?: number;
    alreadyGranted?: number;
    batchInfo?: string;
    filteredScopes?: string[];
    appId?: string;
  },
): string {
  const { scope, isBatchAuth, totalAppScopes, alreadyGranted, batchInfo } = params;
  const t = CARD_TEXTS[locale];
  const scopes = scope?.split(/\s+/).filter(Boolean);

  if (isBatchAuth && scopes && scopes.length > 0) {
    let message = t.batchScopeMsg(scopes.length, totalAppScopes ?? 0, alreadyGranted ?? 0);

    if (scopes.length > 5) {
      const previewScopes = scopes.slice(0, 3).join('\n');
      message += `\n\n${t.scopePreviewLabel}：\n${previewScopes}\n...\n`;
    } else {
      const scopeList = scopes.map((s, idx) => `${idx + 1}. ${s}`).join('\n');
      message += `\n\n${t.scopeListLabel}：\n${scopeList}\n`;
    }

    if (batchInfo) {
      message += `\n\n${batchInfo}`;
    }

    return message;
  }

  if (!scopes?.length) return t.scopeDesc;

  return t.scopeDesc + '\n\n' + t.requiredScopes + '\n' + scopes.map((s) => `- ${s}`).join('\n');
}

export function toInAppWebUrl(targetUrl: string, brand?: LarkBrand): string {
  const encoded = encodeURIComponent(targetUrl);
  const lkMeta = encodeURIComponent(
    JSON.stringify({
      'page-meta': {
        showNavBar: 'false',
        showBottomNavBar: 'false',
      },
    }),
  );
  return (
    `${applinkDomain(brand)}/client/web_url/open` +
    `?mode=sidebar-semi&max_width=800&reload=false&url=${encoded}&lk_meta=${lkMeta}`
  );
}

export function buildAuthSuccessCard(brand?: LarkBrand): Record<string, unknown> {
  const zhT = CARD_TEXTS.zh_cn;
  const enT = CARD_TEXTS.en_us;
  const brandZh = brand === 'lark' ? 'Lark' : '飞书';
  const brandEn = brand === 'lark' ? 'Lark' : 'Feishu';
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: false,
      ...I18N_CONFIG,
      style: {
        color: {
          'light-green-bg': {
            light_mode: 'rgba(52, 199, 89, 0.12)',
            dark_mode: 'rgba(52, 199, 89, 0.08)',
          },
        },
      },
    },
    header: {
      title: i18nPlainText(zhT.authSuccess, enT.authSuccess),
      subtitle: {
        tag: 'plain_text',
        content: '',
      },
      template: 'green',
      padding: '12px 12px 12px 12px',
      icon: {
        tag: 'standard_icon',
        token: 'yes_filled',
      },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: enT.authSuccessBody(brandEn),
          i18n_content: i18nContent(zhT.authSuccessBody(brandZh), enT.authSuccessBody(brandEn)),
        },
      ],
    },
  };
}

export function buildAuthFailedCard(_reason: string): Record<string, unknown> {
  const zhT = CARD_TEXTS.zh_cn;
  const enT = CARD_TEXTS.en_us;
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: false,
      ...I18N_CONFIG,
      style: {
        color: {
          'light-grey-bg': {
            light_mode: 'rgba(142, 142, 147, 0.12)',
            dark_mode: 'rgba(142, 142, 147, 0.08)',
          },
        },
      },
    },
    header: {
      title: i18nPlainText(zhT.authIncomplete, enT.authIncomplete),
      subtitle: {
        tag: 'plain_text',
        content: '',
      },
      template: 'yellow',
      padding: '12px 12px 12px 12px',
      icon: {
        tag: 'standard_icon',
        token: 'warning_filled',
      },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: enT.authExpiredBody,
          i18n_content: i18nContent(zhT.authExpiredBody, enT.authExpiredBody),
        },
      ],
    },
  };
}

export function buildAuthIdentityMismatchCard(brand?: LarkBrand): Record<string, unknown> {
  const zhT = CARD_TEXTS.zh_cn;
  const enT = CARD_TEXTS.en_us;
  const brandZh = brand === 'lark' ? 'Lark' : '飞书';
  const brandEn = brand === 'lark' ? 'Lark' : 'Feishu';
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: false,
      ...I18N_CONFIG,
    },
    header: {
      title: i18nPlainText(zhT.authMismatchTitle, enT.authMismatchTitle),
      subtitle: {
        tag: 'plain_text',
        content: '',
      },
      template: 'red',
      padding: '12px 12px 12px 12px',
      icon: {
        tag: 'standard_icon',
        token: 'close_filled',
      },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: enT.authMismatchBody(brandEn),
          i18n_content: i18nContent(zhT.authMismatchBody(brandZh), enT.authMismatchBody(brandEn)),
        },
      ],
    },
  };
}
