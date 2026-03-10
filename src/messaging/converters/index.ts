/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Content converter mapping for all Feishu message types.
 */

import type { ContentConverterFn } from './types';
import { convertText } from './text';
import { convertPost } from './post';
import { convertImage } from './image';
import { convertFile } from './file';
import { convertAudio } from './audio';
import { convertVideo } from './video';
import { convertSticker } from './sticker';
import { convertInteractive } from './interactive/index';
import { convertShareChat, convertShareUser } from './share';
import { convertLocation } from './location';
import { convertMergeForward } from './merge-forward';
import { convertFolder } from './folder';
import { convertSystem } from './system';
import { convertHongbao } from './hongbao';
import { convertShareCalendarEvent, convertCalendar, convertGeneralCalendar } from './calendar';
import { convertVideoChat } from './video-chat';
import { convertTodo } from './todo';
import { convertVote } from './vote';
import { convertUnknown } from './unknown';

export const converters: ReadonlyMap<string, ContentConverterFn> = new Map([
  ['text', convertText],
  ['post', convertPost],
  ['image', convertImage],
  ['file', convertFile],
  ['audio', convertAudio],
  ['video', convertVideo],
  ['media', convertVideo],
  ['sticker', convertSticker],
  ['interactive', convertInteractive],
  ['share_chat', convertShareChat],
  ['share_user', convertShareUser],
  ['location', convertLocation],
  ['merge_forward', convertMergeForward],
  ['folder', convertFolder],
  ['system', convertSystem],
  ['hongbao', convertHongbao],
  ['share_calendar_event', convertShareCalendarEvent],
  ['calendar', convertCalendar],
  ['general_calendar', convertGeneralCalendar],
  ['video_chat', convertVideoChat],
  ['todo', convertTodo],
  ['vote', convertVote],
  ['unknown', convertUnknown],
]);
