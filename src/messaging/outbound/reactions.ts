/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Reaction management for the Lark/Feishu channel plugin.
 *
 * Provides functions to add, remove, and list emoji reactions on Feishu
 * messages using the IM Message Reaction API.
 */

import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import { LarkClient } from '../../core/lark-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Represents a single reaction on a Feishu message.
 */
export interface FeishuReaction {
  /** Unique reaction ID assigned by the platform. */
  reactionId: string;
  /** The emoji type string (e.g. "THUMBSUP", "HEART"). */
  emojiType: string;
  /** Whether the reaction was added by an app or a human user. */
  operatorType: 'app' | 'user';
  /** Open ID of the operator who added the reaction. */
  operatorId: string;
}

// ---------------------------------------------------------------------------
// Feishu emoji constants
// ---------------------------------------------------------------------------

/**
 * Well-known Feishu emoji type strings.
 *
 * This is a convenience map so consumers do not need to memorise the
 * exact string identifiers. It is intentionally non-exhaustive --
 * Feishu supports many more emoji types. Any valid emoji type string
 * can be passed directly to the API functions.
 */
export const FeishuEmoji = {
  THUMBSUP: 'THUMBSUP',
  THUMBSDOWN: 'THUMBSDOWN',
  HEART: 'HEART',
  SMILE: 'SMILE',
  JOYFUL: 'JOYFUL',
  FROWN: 'FROWN',
  BLUSH: 'BLUSH',
  OK: 'OK',
  CLAP: 'CLAP',
  FIREWORKS: 'FIREWORKS',
  PARTY: 'PARTY',
  MUSCLE: 'MUSCLE',
  FIRE: 'FIRE',
  EYES: 'EYES',
  THINKING: 'THINKING',
  PRAISE: 'PRAISE',
  PRAY: 'PRAY',
  ROCKET: 'ROCKET',
  DONE: 'DONE',
  SKULL: 'SKULL',
  HUNDREDPOINTS: 'HUNDREDPOINTS',
  FACEPALM: 'FACEPALM',
  CHECK: 'CHECK',
  CROSSMARK: 'CrossMark',
  COOL: 'COOL',
  TYPING: 'Typing',
  SPEECHLESS: 'SPEECHLESS',
} as const;

// ---------------------------------------------------------------------------
// Valid Feishu emoji types (complete set)
// ---------------------------------------------------------------------------

/**
 * Complete set of valid Feishu emoji type strings for reactions.
 *
 * Sourced from the official Feishu emoji documentation.
 * Unlike `FeishuEmoji` (a convenience subset), this set is exhaustive
 * and can be used for validation and error reporting.
 *
 * @see https://go.feishu.cn/s/670vFWbA804
 */
export const VALID_FEISHU_EMOJI_TYPES: ReadonlySet<string> = new Set([
  // Gestures / actions
  'OK',
  'THUMBSUP',
  'THANKS',
  'MUSCLE',
  'FINGERHEART',
  'APPLAUSE',
  'FISTBUMP',
  'JIAYI',
  'DONE',
  // Faces / expressions
  'SMILE',
  'BLUSH',
  'LAUGH',
  'SMIRK',
  'LOL',
  'FACEPALM',
  'LOVE',
  'WINK',
  'PROUD',
  'WITTY',
  'SMART',
  'SCOWL',
  'THINKING',
  'SOB',
  'CRY',
  'ERROR',
  'NOSEPICK',
  'HAUGHTY',
  'SLAP',
  'SPITBLOOD',
  'TOASTED',
  'GLANCE',
  'DULL',
  'INNOCENTSMILE',
  'JOYFUL',
  'WOW',
  'TRICK',
  'YEAH',
  'ENOUGH',
  'TEARS',
  'EMBARRASSED',
  'KISS',
  'SMOOCH',
  'DROOL',
  'OBSESSED',
  'MONEY',
  'TEASE',
  'SHOWOFF',
  'COMFORT',
  'CLAP',
  'PRAISE',
  'STRIVE',
  'XBLUSH',
  'SILENT',
  'WAVE',
  'WHAT',
  'FROWN',
  'SHY',
  'DIZZY',
  'LOOKDOWN',
  'CHUCKLE',
  'WAIL',
  'CRAZY',
  'WHIMPER',
  'HUG',
  'BLUBBER',
  'WRONGED',
  'HUSKY',
  'SHHH',
  'SMUG',
  'ANGRY',
  'HAMMER',
  'SHOCKED',
  'TERROR',
  'PETRIFIED',
  'SKULL',
  'SWEAT',
  'SPEECHLESS',
  'SLEEP',
  'DROWSY',
  'YAWN',
  'SICK',
  'PUKE',
  'BETRAYED',
  'HEADSET',
  'EatingFood',
  'MeMeMe',
  'Sigh',
  'Typing',
  'SLIGHT',
  'TONGUE',
  'EYESCLOSED',
  'RoarForYou',
  'CALF',
  'BEAR',
  'BULL',
  'RAINBOWPUKE',
  // Objects / food / drinks
  'Lemon',
  'ROSE',
  'HEART',
  'PARTY',
  'LIPS',
  'BEER',
  'CAKE',
  'GIFT',
  'CUCUMBER',
  'Drumstick',
  'Pepper',
  'CANDIEDHAWS',
  'BubbleTea',
  'Coffee',
  // Symbols / marks
  'Get',
  'LGTM',
  'OnIt',
  'OneSecond',
  'VRHeadset',
  'YouAreTheBest',
  'SALUTE',
  'SHAKE',
  'HIGHFIVE',
  'UPPERLEFT',
  'ThumbsDown',
  'Yes',
  'No',
  'OKR',
  'CheckMark',
  'CrossMark',
  'MinusOne',
  'Hundred',
  'AWESOMEN',
  'Pin',
  'Alarm',
  'Loudspeaker',
  'Trophy',
  'Fire',
  'BOMB',
  'Music',
  // Holidays / seasons
  'XmasTree',
  'Snowman',
  'XmasHat',
  'FIREWORKS',
  '2022',
  'REDPACKET',
  'FORTUNE',
  'LUCK',
  'FIRECRACKER',
  'StickyRiceBalls',
  // Miscellaneous
  'HEARTBROKEN',
  'POOP',
  'StatusFlashOfInspiration',
  '18X',
  'CLEAVER',
  'Soccer',
  'Basketball',
  // Status
  'GeneralDoNotDisturb',
  'Status_PrivateMessage',
  'GeneralInMeetingBusy',
  'StatusReading',
  'StatusInFlight',
  'GeneralBusinessTrip',
  'GeneralWorkFromHome',
  'StatusEnjoyLife',
  'GeneralTravellingCar',
  'StatusBus',
  'GeneralSun',
  'GeneralMoonRest',
  // Holiday extras
  'MoonRabbit',
  'Mooncake',
  'JubilantRabbit',
  'TV',
  'Movie',
  'Pumpkin',
  // Newer additions
  'BeamingFace',
  'Delighted',
  'ColdSweat',
  'FullMoonFace',
  'Partying',
  'GoGoGo',
  'ThanksFace',
  'SaluteFace',
  'Shrug',
  'ClownFace',
  'HappyDragon',
]);

// ---------------------------------------------------------------------------
// addReactionFeishu
// ---------------------------------------------------------------------------

/**
 * Add an emoji reaction to a Feishu message.
 *
 * @param params.cfg       - Plugin configuration with Feishu credentials.
 * @param params.messageId - The message to react to.
 * @param params.emojiType - The emoji type string (e.g. "THUMBSUP").
 * @param params.accountId - Optional account identifier for multi-account setups.
 * @returns An object containing the platform-assigned reaction ID.
 */
export async function addReactionFeishu(params: {
  cfg: OpenClawConfig;
  messageId: string;
  emojiType: string;
  accountId?: string;
}): Promise<{ reactionId: string }> {
  const { cfg, messageId, emojiType, accountId } = params;

  const client = LarkClient.fromCfg(cfg, accountId).sdk;

  let response;
  try {
    response = await client.im.messageReaction.create({
      path: {
        message_id: messageId,
      },
      data: {
        reaction_type: {
          emoji_type: emojiType,
        },
      },
    });
  } catch (err) {
    const e = err as { code?: number; msg?: string; response?: { data?: { code?: number } } };
    const errCode = e.code ?? e.response?.data?.code;
    if (errCode === 231001) {
      const validTypes = Array.from(VALID_FEISHU_EMOJI_TYPES).join(', ');
      throw new Error(`Emoji type "${emojiType}" is not a valid Feishu reaction. Valid types: ${validTypes}`);
    }
    throw err;
  }

  const reactionId = response?.data?.reaction_id;
  if (!reactionId) {
    throw new Error(
      `[feishu-reactions] Failed to add reaction "${emojiType}" to message ${messageId}: no reaction_id returned`,
    );
  }

  return { reactionId };
}

// ---------------------------------------------------------------------------
// removeReactionFeishu
// ---------------------------------------------------------------------------

/**
 * Remove a specific reaction from a Feishu message by its reaction ID.
 *
 * Unlike the outbound module's `removeReaction` (which looks up the
 * reaction by emoji type), this function takes the exact reaction ID
 * for direct deletion.
 *
 * @param params.cfg        - Plugin configuration with Feishu credentials.
 * @param params.messageId  - The message the reaction belongs to.
 * @param params.reactionId - The platform-assigned reaction ID to delete.
 * @param params.accountId  - Optional account identifier for multi-account setups.
 */
export async function removeReactionFeishu(params: {
  cfg: OpenClawConfig;
  messageId: string;
  reactionId: string;
  accountId?: string;
}): Promise<void> {
  const { cfg, messageId, reactionId, accountId } = params;

  const client = LarkClient.fromCfg(cfg, accountId).sdk;

  await client.im.messageReaction.delete({
    path: {
      message_id: messageId,
      reaction_id: reactionId,
    },
  });
}

// ---------------------------------------------------------------------------
// listReactionsFeishu
// ---------------------------------------------------------------------------

/**
 * List reactions on a Feishu message, optionally filtered by emoji type.
 *
 * Paginates through all results and returns a flat array of
 * {@link FeishuReaction} objects.
 *
 * @param params.cfg       - Plugin configuration with Feishu credentials.
 * @param params.messageId - The message whose reactions to list.
 * @param params.emojiType - Optional emoji type filter (e.g. "THUMBSUP").
 *                           When omitted, all reaction types are returned.
 * @param params.accountId - Optional account identifier for multi-account setups.
 * @returns An array of reactions matching the criteria.
 */
export async function listReactionsFeishu(params: {
  cfg: OpenClawConfig;
  messageId: string;
  emojiType?: string;
  accountId?: string;
}): Promise<FeishuReaction[]> {
  const { cfg, messageId, emojiType, accountId } = params;

  const client = LarkClient.fromCfg(cfg, accountId).sdk;

  const reactions: FeishuReaction[] = [];
  let pageToken: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const requestParams: Record<string, unknown> = {
      page_size: 50,
    };

    if (emojiType) {
      requestParams.reaction_type = emojiType;
    }

    if (pageToken) {
      requestParams.page_token = pageToken;
    }

    const response = await client.im.messageReaction.list({
      path: {
        message_id: messageId,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params: requestParams as any,
    });

    const items = response?.data?.items;
    if (items && items.length > 0) {
      for (const item of items) {
        reactions.push({
          reactionId: item.reaction_id ?? '',
          emojiType: item.reaction_type?.emoji_type ?? '',
          operatorType: item.operator?.operator_type === 'app' ? 'app' : 'user',
          operatorId: item.operator?.operator_id ?? '',
        });
      }
    }

    pageToken = response?.data?.page_token ?? undefined;
    hasMore = response?.data?.has_more === true && !!pageToken;
  }

  return reactions;
}
