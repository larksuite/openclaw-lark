/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Types and constants for the interactive (card) converter.
 */

export type Obj = Record<string, unknown>;

export interface RawCardContent {
  json_card: string;
  json_attachment?: string;
  card_schema?: number;
}

export interface ConvertCardResult {
  content: string;
  schema: number;
}

export interface TextStyle {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
}

export const EMOJI_MAP: Record<string, string> = {
  OK: '👌',
  THUMBSUP: '👍',
  SMILE: '😊',
  HEART: '❤️',
  CLAP: '👏',
  FIRE: '🔥',
  PARTY: '🎉',
  THINK: '🤔',
};

export const CHART_TYPE_NAMES: Record<string, string> = {
  bar: '柱状图',
  line: '折线图',
  pie: '饼图',
  area: '面积图',
  radar: '雷达图',
  scatter: '散点图',
};
