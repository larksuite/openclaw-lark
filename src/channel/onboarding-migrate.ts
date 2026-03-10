/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Legacy groupAllowFrom migration for Feishu onboarding.
 *
 * Handles the migration of chat_id entries (oc_xxx) from
 * groupAllowFrom to the groups config, preserving the original
 * semantic of "allow this group for any sender".
 */

import type { ClawdbotConfig, WizardPrompter } from 'openclaw/plugin-sdk';
import type { FeishuConfig, FeishuGroupConfig } from '../core/types';
import { setFeishuGroups, setFeishuGroupAllowFrom } from './onboarding-config';

/**
 * Detect and migrate legacy chat_id entries in groupAllowFrom.
 *
 * Old semantic: groupAllowFrom contained chat_ids (oc_xxx) to control
 * which groups could use the bot.
 * New semantic: groupAllowFrom is for sender filtering (open_ids like ou_xxx).
 *
 * This function prompts the user and, if confirmed, moves chat_ids
 * to the groups config and keeps only sender IDs in groupAllowFrom.
 */
export async function migrateLegacyGroupAllowFrom(params: {
  cfg: ClawdbotConfig;
  prompter: WizardPrompter;
}): Promise<ClawdbotConfig> {
  let next = params.cfg;
  const { prompter } = params;

  const existingGroupAllowFrom = (next.channels?.feishu as FeishuConfig | undefined)?.groupAllowFrom ?? [];
  const legacyChatIds = existingGroupAllowFrom.filter((e) => String(e).startsWith('oc_'));
  const senderAllowFrom = existingGroupAllowFrom.filter((e) => !String(e).startsWith('oc_'));

  if (legacyChatIds.length === 0) {
    return next;
  }

  await prompter.note(
    [
      `⚠️  Detected legacy config: groupAllowFrom contains chat_ids (${legacyChatIds.join(', ')})`,
      '',
      'Old semantic: groupAllowFrom controlled which groups could use the bot.',
      'New semantic: groupAllowFrom is for SENDER filtering (open_ids like ou_xxx).',
      '',
      'Recommended migration:',
      `  1. Move chat_ids (oc_xxx) → channels.feishu.groups`,
      `  2. Keep sender IDs (ou_xxx) in groupAllowFrom`,
    ].join('\n'),
    'Legacy config detected',
  );

  const migrate = await prompter.confirm({
    message: `Migrate ${legacyChatIds.length} chat_id(s) to groups config?`,
    initialValue: true,
  });

  if (migrate) {
    const existingGroups = (next.channels?.feishu as FeishuConfig | undefined)?.groups ?? {};
    const migratedGroups: Record<string, FeishuGroupConfig> = {
      ...existingGroups,
    };
    for (const chatId of legacyChatIds) {
      if (!migratedGroups[String(chatId)]) {
        migratedGroups[String(chatId)] = {
          enabled: true,
          groupPolicy: 'open',
        } as FeishuGroupConfig;
      }
    }
    next = setFeishuGroups(next, migratedGroups as Record<string, object>);

    next = setFeishuGroupAllowFrom(next, senderAllowFrom);

    await prompter.note(
      `✅ Migrated: ${legacyChatIds.length} chat_id(s) moved to groups, ` +
        `${senderAllowFrom.length} sender(s) kept in groupAllowFrom`,
      'Migration complete',
    );
  } else {
    await prompter.note('Skipped migration. Please update config manually to avoid issues.', 'Migration skipped');
  }

  return next;
}
