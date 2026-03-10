/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Common response type helpers for Lark SDK.
 *
 * The Lark Node SDK's generic response types often lack specific field
 * definitions for `data`, requiring `as any` casts.  These lightweight
 * interfaces let us replace `(res.data as any)?.items` with a single typed
 * assertion at the top of each block.
 */

/** Standard paginated list response (items / has_more / page_token). */
export interface PaginatedData<T = unknown> {
  items?: T[];
  has_more?: boolean;
  page_token?: string;
  total?: number;
}

/** Calendar-specific list response that uses `calendar_list` key. */
export interface CalendarListData {
  calendar_list?: unknown[];
  has_more?: boolean;
  page_token?: string;
}

/** Calendar primary response. */
export interface CalendarPrimaryData {
  calendars?: Array<{ calendar?: { calendar_id?: string } }>;
}

/** Freebusy response. */
export interface FreebusyData {
  freebusy_lists?: unknown[];
}

/** Drive file list response (uses `files` key). */
export interface DriveFileListData {
  files?: unknown[];
  has_more?: boolean;
  next_page_token?: string;
}

/** Drive file copy / create response. */
export interface DriveFileData {
  file?: { token?: string; [key: string]: unknown };
}

/** Drive async task response (move / delete). */
export interface DriveTaskData {
  task_id?: string;
}

/** Bitable app list response (uses `files` key from drive search). */
export interface BitableAppListData {
  files?: unknown[];
  has_more?: boolean;
  page_token?: string;
}

/** Field create / update response. */
export interface FieldData {
  field?: { field_id?: string; [key: string]: unknown };
}

/** Chat member list response. */
export interface ChatMemberListData {
  items?: unknown[];
  member_total?: number;
  has_more?: boolean;
  page_token?: string;
}

/** Search user response. */
export interface SearchUserData {
  users?: unknown[];
  has_more?: boolean;
  page_token?: string;
}

/** Task create response. */
export interface TaskCreateData {
  task?: { guid?: string; [key: string]: unknown };
}

/** Calendar get response. */
export interface CalendarGetData {
  calendar?: unknown;
}

/** Comment list reply response. */
export interface CommentReplyListData {
  items?: unknown[];
  has_more?: boolean;
  page_token?: string;
}
