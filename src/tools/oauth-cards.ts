/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * oauth-cards.ts — OAuth 授权卡片构建函数。
 *
 * 从 oauth.ts 提取的纯 UI 函数，与 OAuth 业务流程解耦。
 */

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
  } = params;
  const inAppUrl = toInAppWebUrl(verificationUriComplete);
  const multiUrl = {
    url: inAppUrl,
    pc_url: inAppUrl,
    android_url: inAppUrl,
    ios_url: inAppUrl,
  };

  // 将 scope 转成可读说明
  const scopeDesc = formatScopeDescription(
    scope,
    isBatchAuth,
    totalAppScopes,
    alreadyGranted,
    batchInfo,
    filteredScopes,
    appId,
  );

  const elements: Record<string, unknown>[] = [
    // 授权说明
    {
      tag: 'markdown',
      content: scopeDesc,
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
              text: { tag: 'plain_text', content: '前往授权' },
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
      content: `<font color='grey'>授权链接将在 ${expiresMin} 分钟后失效，届时需重新发起</font>`,
      text_size: 'notation',
    },
    // 批量授权提示（仅 auto-auth 流程展示）
    ...(showBatchAuthHint
      ? [
          {
            tag: 'markdown',
            content:
              "<font color='grey'>💡如果你希望一次性授予所有插件所需要的权限，可以告诉我「授予所有用户权限」，我会协助你完成。</font>",
            text_size: 'notation',
          },
        ]
      : []),
  ];

  return {
    schema: '2.0',
    config: {
      wide_screen_mode: false,
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
      title: {
        tag: 'plain_text',
        content: '需要您的授权才能继续',
      },
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

/** scope 字符串 → 可读描述 */
export function formatScopeDescription(
  scope?: string,
  isBatchAuth?: boolean,
  totalAppScopes?: number,
  alreadyGranted?: number,
  batchInfo?: string,
  _filteredScopes?: string[],
  _appId?: string,
): string {
  const scopes = scope?.split(/\s+/).filter(Boolean);

  if (isBatchAuth && scopes && scopes.length > 0) {
    let message = `应用需要授权 **${scopes.length}** 个用户权限（共 ${totalAppScopes} 个，已授权 ${alreadyGranted} 个）。`;

    // 如果超过 5 个 scope，只显示前 3 个，然后用"..."表示
    if (scopes.length > 5) {
      const previewScopes = scopes.slice(0, 3).join('\n');
      message += `\n\n**将要授权的权限**：\n${previewScopes}\n...\n`;
    } else {
      const scopeList = scopes.map((s, idx) => `${idx + 1}. ${s}`).join('\n');
      message += `\n\n**将要授权的权限列表**：\n${scopeList}\n`;
    }

    // 添加分批提示信息
    if (batchInfo) {
      message += `\n\n${batchInfo}`;
    }

    return message;
  }

  const desc = '授权后，应用将能够以您的身份执行相关操作。';
  if (!scopes?.length) return desc;

  const message = desc + '\n\n所需权限：\n' + scopes.map((s) => `- ${s}`).join('\n');

  return message;
}

export function toInAppWebUrl(targetUrl: string): string {
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
    'https://applink.feishu.cn/client/web_url/open' +
    `?mode=sidebar-semi&max_width=800&reload=false&url=${encoded}&lk_meta=${lkMeta}`
  );
}

export function buildAuthSuccessCard(): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: false,
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
      title: {
        tag: 'plain_text',
        content: '授权成功',
      },
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
          content:
            '您的飞书账号已成功授权，正在为您继续执行操作。\n\n' +
            "<font color='grey'>如需撤销授权，可随时告诉我。</font>",
        },
      ],
    },
  };
}

export function buildAuthFailedCard(_reason: string): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: false,
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
      title: {
        tag: 'plain_text',
        content: '授权未完成',
      },
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
          content: '授权链接已过期，请重新发起授权。',
        },
      ],
    },
  };
}

export function buildAuthIdentityMismatchCard(): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: false,
    },
    header: {
      title: {
        tag: 'plain_text',
        content: '授权失败，操作账号与发起账号不一致',
      },
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
          content:
            '检测到当前进行授权操作的飞书账号与发起授权请求的账号不一致。为保障数据安全，本次授权已被拒绝。\n\n' +
            "<font color='grey'>请授权请求的发起人使用其账号，点击授权链接完成授权。</font>",
        },
      ],
    },
  };
}
