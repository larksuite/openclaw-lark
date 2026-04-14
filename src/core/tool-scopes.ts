/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Tool Scopes 配置
 *
 * 定义所有工具动作所需的飞书权限映射。
 *
 * ## 维护方式
 *
 * ⚠️ 此文件采用**手动维护**，新增或修改工具时需同步更新。
 *
 * ### 新增工具动作
 *
 * 1. 在 `ToolActionKey` 类型中添加新键：
 *    ```typescript
 *    export type ToolActionKey =
 *      | "feishu_calendar_event.create"
 *      | "feishu_new_tool.action"  // 新增
 *    ```
 *
 * 2. 在 `TOOL_SCOPES` 对象中添加对应配置：
 *    ```typescript
 *    export const TOOL_SCOPES: ToolScopeMapping = {
 *      "feishu_new_tool.action": [
 *        "required:scope:here"
 *      ],
 *    };
 *    ```
 *
 * 3. 运行 TypeScript 类型检查验证一致性：
 *    ```bash
 *    cd openclaw/feishu && npx tsc --noEmit
 *    ```
 *
 * ### 如何确定所需 Scope
 *
 * 1. **查阅飞书开放平台 API 文档**：https://open.feishu.cn/document
 * 2. **使用 feishu-oapi-search skill**：在 Claude Code 中搜索 API 文档
 * 3. **参考类似工具**：查看功能相近的工具的 scope 配置
 * 4. **实际测试**：观察 API 调用的错误码（LARK_ERROR.APP_SCOPE_MISSING/99991672=应用缺权限，LARK_ERROR.USER_SCOPE_INSUFFICIENT/99991679=用户缺授权）
 *
 * 最后更新: 2026-03-03
 */

// ===== 类型定义 =====

/**
 * 所有可用的工具动作键
 *
 * 格式：{tool_name}.{action_name}
 *
 * 示例：
 * - "feishu_calendar_event.create"
 * - "feishu_bitable_app_table_record.update"
 *
 * 总计：96 个工具动作
 */
export type ToolActionKey =
  | 'feishu_bitable_app.copy'
  | 'feishu_bitable_app.create'
  | 'feishu_bitable_app.get'
  | 'feishu_bitable_app.list'
  | 'feishu_bitable_app.patch'
  | 'feishu_bitable_app_table.batch_create'
  | 'feishu_bitable_app_table.create'
  | 'feishu_bitable_app_table.list'
  | 'feishu_bitable_app_table.patch'
  | 'feishu_bitable_app_table_field.create'
  | 'feishu_bitable_app_table_field.delete'
  | 'feishu_bitable_app_table_field.list'
  | 'feishu_bitable_app_table_field.update'
  | 'feishu_bitable_app_table_record.batch_create'
  | 'feishu_bitable_app_table_record.batch_delete'
  | 'feishu_bitable_app_table_record.batch_update'
  | 'feishu_bitable_app_table_record.create'
  | 'feishu_bitable_app_table_record.delete'
  | 'feishu_bitable_app_table_record.list'
  | 'feishu_bitable_app_table_record.update'
  | 'feishu_bitable_app_table_view.create'
  | 'feishu_bitable_app_table_view.get'
  | 'feishu_bitable_app_table_view.list'
  | 'feishu_bitable_app_table_view.patch'
  | 'feishu_calendar_calendar.get'
  | 'feishu_calendar_calendar.list'
  | 'feishu_calendar_calendar.primary'
  | 'feishu_calendar_event.create'
  | 'feishu_calendar_event.delete'
  | 'feishu_calendar_event.get'
  | 'feishu_calendar_event.instance_view'
  | 'feishu_calendar_event.instances'
  | 'feishu_calendar_event.list'
  | 'feishu_calendar_event.patch'
  | 'feishu_calendar_event.reply'
  | 'feishu_calendar_event.search'
  | 'feishu_calendar_event_attendee.create'
  | 'feishu_calendar_event_attendee.list'
  | 'feishu_calendar_freebusy.list'
  | 'feishu_chat.get'
  | 'feishu_chat.search'
  | 'feishu_chat_members.default'
  | 'feishu_create_doc.default'
  | 'feishu_doc_comments.create'
  | 'feishu_doc_comments.list'
  | 'feishu_doc_comments.list_replies'
  | 'feishu_doc_comments.patch'
  | 'feishu_doc_comments.reply'
  | 'feishu_doc_media.download'
  | 'feishu_doc_media.insert'
  | 'feishu_drive_file.copy'
  | 'feishu_drive_file.delete'
  | 'feishu_drive_file.download'
  | 'feishu_drive_file.get_meta'
  | 'feishu_drive_file.list'
  | 'feishu_drive_file.move'
  | 'feishu_drive_file.upload'
  | 'feishu_fetch_doc.default'
  | 'feishu_get_user.basic_batch'
  | 'feishu_get_user.default'
  | 'feishu_im_user_fetch_resource.default'
  | 'feishu_im_user_get_messages.default'
  | 'feishu_im_user_message.reply'
  | 'feishu_im_user_message.send'
  | 'feishu_im_user_search_messages.default'
  | 'feishu_search_doc_wiki.search'
  | 'feishu_search_user.default'
  | 'feishu_task_comment.create'
  | 'feishu_task_comment.get'
  | 'feishu_task_comment.list'
  | 'feishu_task_section.create'
  | 'feishu_task_section.get'
  | 'feishu_task_section.list'
  | 'feishu_task_section.patch'
  | 'feishu_task_section.tasks'
  | 'feishu_task_subtask.create'
  | 'feishu_task_subtask.list'
  | 'feishu_task_task.create'
  | 'feishu_task_task.get'
  | 'feishu_task_task.list'
  | 'feishu_task_task.patch'
  | 'feishu_task_task.add_members'
  | 'feishu_task_tasklist.add_members'
  | 'feishu_task_tasklist.create'
  | 'feishu_task_tasklist.get'
  | 'feishu_task_tasklist.list'
  | 'feishu_task_tasklist.patch'
  | 'feishu_task_tasklist.tasks'
  | 'feishu_update_doc.default'
  | 'feishu_wiki_space.create'
  | 'feishu_wiki_space.get'
  | 'feishu_wiki_space.list'
  | 'feishu_wiki_space_node.copy'
  | 'feishu_wiki_space_node.create'
  | 'feishu_wiki_space_node.get'
  | 'feishu_wiki_space_node.list'
  | 'feishu_wiki_space_node.move'
  | 'feishu_sheet.info'
  | 'feishu_sheet.read'
  | 'feishu_sheet.write'
  | 'feishu_sheet.append'
  | 'feishu_sheet.find'
  | 'feishu_sheet.create'
  | 'feishu_sheet.export';
/**
 * Tool Scope 映射类型
 *
 * 将每个 ToolActionKey 映射到其所需的 scope 数组
 */
export type ToolScopeMapping = Record<ToolActionKey, string[]>;

// ===== 数据 =====

/**
 * Tool Scope 数据
 *
 * 每个工具动作所需的飞书权限列表（Required Scopes）
 *
 * ## 数据说明
 *
 * - 空数组 `[]` 表示该工具动作不需要任何权限
 * - 多个权限表示需要同时拥有所有权限（AND 关系）
 * - 所有 scope 都是 user scopes（用户级权限）
 *
 * ## 示例
 *
 * ```typescript
 * TOOL_SCOPES["feishu_calendar_event.create"]
 * // 返回: ["calendar:calendar.event:create", "calendar:calendar.event:update"]
 * ```
 *
 * @see {@link ToolActionKey} 所有可用的工具动作键
 */
export const TOOL_SCOPES: ToolScopeMapping = {
  'feishu_bitable_app.create': ['base:app:create'],
  'feishu_bitable_app.get': ['base:app:read'],
  'feishu_bitable_app.list': ['space:document:retrieve'],
  'feishu_bitable_app.patch': ['base:app:update'],
  'feishu_bitable_app.copy': ['base:app:copy'],
  'feishu_bitable_app_table.create': ['base:table:create'],
  'feishu_bitable_app_table.list': ['base:table:read'],
  'feishu_bitable_app_table.patch': ['base:table:update'],
  'feishu_bitable_app_table.batch_create': ['base:table:create'],
  'feishu_bitable_app_table_record.create': ['base:record:create'],
  'feishu_bitable_app_table_record.update': ['base:record:update'],
  'feishu_bitable_app_table_record.delete': ['base:record:delete'],
  'feishu_bitable_app_table_record.batch_create': ['base:record:create'],
  'feishu_bitable_app_table_record.batch_update': ['base:record:update'],
  'feishu_bitable_app_table_record.batch_delete': ['base:record:delete'],
  'feishu_bitable_app_table_record.list': ['base:record:retrieve'],
  'feishu_bitable_app_table_field.create': ['base:field:create'],
  'feishu_bitable_app_table_field.list': ['base:field:read'],
  'feishu_bitable_app_table_field.update': ['base:field:read', 'base:field:update'],
  'feishu_bitable_app_table_field.delete': ['base:field:delete'],
  'feishu_bitable_app_table_view.create': ['base:view:write_only'],
  'feishu_bitable_app_table_view.get': ['base:view:read'],
  'feishu_bitable_app_table_view.list': ['base:view:read'],
  'feishu_bitable_app_table_view.patch': ['base:view:write_only'],
  'feishu_calendar_calendar.list': ['calendar:calendar:read'],
  'feishu_calendar_calendar.get': ['calendar:calendar:read'],
  'feishu_calendar_calendar.primary': ['calendar:calendar:read'],
  'feishu_calendar_event.create': ['calendar:calendar.event:create', 'calendar:calendar.event:update'],
  'feishu_calendar_event.list': ['calendar:calendar.event:read'],
  'feishu_calendar_event.get': ['calendar:calendar.event:read'],
  'feishu_calendar_event.patch': ['calendar:calendar.event:update'],
  'feishu_calendar_event.delete': ['calendar:calendar.event:delete'],
  'feishu_calendar_event.search': ['calendar:calendar.event:read'],
  'feishu_calendar_event.reply': ['calendar:calendar.event:reply'],
  'feishu_calendar_event.instances': ['calendar:calendar.event:read'],
  'feishu_calendar_event.instance_view': ['calendar:calendar.event:read'],
  'feishu_calendar_event_attendee.create': ['calendar:calendar.event:update'],
  'feishu_calendar_event_attendee.list': ['calendar:calendar.event:read'],
  'feishu_calendar_freebusy.list': ['calendar:calendar.free_busy:read'],
  'feishu_task_task.create': ['task:task:write', 'task:task:writeonly'],
  'feishu_task_task.get': ['task:task:read', 'task:task:write'],
  'feishu_task_task.list': ['task:task:read', 'task:task:write'],
  'feishu_task_task.patch': ['task:task:write', 'task:task:writeonly'],
  'feishu_task_task.add_members': ['task:task:write', 'task:task:writeonly'],
  'feishu_task_tasklist.create': ['task:tasklist:write'],
  'feishu_task_tasklist.get': ['task:tasklist:read', 'task:tasklist:write'],
  'feishu_task_tasklist.list': ['task:tasklist:read', 'task:tasklist:write'],
  'feishu_task_tasklist.tasks': ['task:tasklist:read', 'task:tasklist:write'],
  'feishu_task_tasklist.patch': ['task:tasklist:write'],
  'feishu_task_tasklist.add_members': ['task:tasklist:write'],
  'feishu_task_comment.create': ['task:comment:write'],
  'feishu_task_comment.list': ['task:comment:read', 'task:comment:write'],
  'feishu_task_comment.get': ['task:comment:read', 'task:comment:write'],
  'feishu_task_section.create': ['task:task'],
  'feishu_task_section.get': ['task:task'],
  'feishu_task_section.list': ['task:task'],
  'feishu_task_section.patch': ['task:task'],
  'feishu_task_section.tasks': ['task:task'],
  'feishu_task_subtask.create': ['task:task:write'],
  'feishu_task_subtask.list': ['task:task:read', 'task:task:write'],
  'feishu_chat.search': ['im:chat:read'],
  'feishu_chat.get': ['im:chat:read'],
  'feishu_chat_members.default': ['im:chat.members:read'],
  'feishu_drive_file.list': ['space:document:retrieve'],
  'feishu_drive_file.get_meta': ['drive:drive.metadata:readonly'],
  'feishu_drive_file.copy': ['docs:document:copy'],
  'feishu_drive_file.move': ['space:document:move'],
  'feishu_drive_file.delete': ['space:document:delete'],
  'feishu_drive_file.upload': ['drive:file:upload'],
  'feishu_drive_file.download': ['drive:file:download'],
  'feishu_doc_media.download': ['board:whiteboard:node:read', 'docs:document.media:download'],
  'feishu_doc_media.insert': ['docx:document:write_only', 'docs:document.media:upload'],
  'feishu_doc_comments.list': ['wiki:node:read', 'docs:document.comment:read'],
  'feishu_doc_comments.list_replies': ['wiki:node:read', 'docs:document.comment:read'],
  'feishu_doc_comments.create': ['wiki:node:read', 'docs:document.comment:create'],
  'feishu_doc_comments.reply': ['wiki:node:read', 'docs:document.comment:create'],
  'feishu_doc_comments.patch': ['docs:document.comment:update'],
  'feishu_wiki_space.list': ['wiki:space:retrieve'],
  'feishu_wiki_space.get': ['wiki:space:read'],
  'feishu_wiki_space.create': ['wiki:space:write_only'],
  'feishu_wiki_space_node.list': ['wiki:node:retrieve'],
  'feishu_wiki_space_node.get': ['wiki:node:read'],
  'feishu_wiki_space_node.create': ['wiki:node:create'],
  'feishu_wiki_space_node.move': ['wiki:node:move'],
  'feishu_wiki_space_node.copy': ['wiki:node:copy'],
  'feishu_im_user_message.send': ['im:message', 'im:message.send_as_user'],
  'feishu_im_user_message.reply': ['im:message', 'im:message.send_as_user'],
  'feishu_im_user_fetch_resource.default': [
    'im:message.group_msg:get_as_user',
    'im:message.p2p_msg:get_as_user',
    'im:message:readonly',
  ],
  'feishu_im_user_get_messages.default': [
    'im:chat:read',
    'im:message:readonly',
    'im:message.group_msg:get_as_user',
    'im:message.p2p_msg:get_as_user',
    'contact:contact.base:readonly',
    'contact:user.base:readonly',
  ],
  'feishu_im_user_search_messages.default': [
    'im:chat:read',
    'im:message:readonly',
    'im:message.group_msg:get_as_user',
    'im:message.p2p_msg:get_as_user',
    'contact:contact.base:readonly',
    'contact:user.base:readonly',
    'search:message',
  ],
  'feishu_search_doc_wiki.search': ['search:docs:read'],
  'feishu_get_user.basic_batch': ['contact:user.basic_profile:readonly'],
  'feishu_get_user.default': ['contact:contact.base:readonly', 'contact:user.base:readonly'],
  'feishu_search_user.default': ['contact:user:search'],
  'feishu_create_doc.default': [
    'board:whiteboard:node:create',
    'docx:document:create',
    'docx:document:readonly',
    'docx:document:write_only',
    'wiki:node:create',
    'wiki:node:read',
    'docs:document.media:upload',
  ],
  'feishu_fetch_doc.default': ['docx:document:readonly', 'wiki:node:read'],
  'feishu_update_doc.default': [
    'board:whiteboard:node:create',
    'docx:document:create',
    'docx:document:readonly',
    'docx:document:write_only',
  ],
  'feishu_sheet.info': ['sheets:spreadsheet.meta:read', 'sheets:spreadsheet:read'],
  'feishu_sheet.read': ['sheets:spreadsheet.meta:read', 'sheets:spreadsheet:read'],
  'feishu_sheet.write': [
    'sheets:spreadsheet.meta:read',
    'sheets:spreadsheet:read',
    'sheets:spreadsheet:create',
    'sheets:spreadsheet:write_only',
  ],
  'feishu_sheet.append': [
    'sheets:spreadsheet.meta:read',
    'sheets:spreadsheet:read',
    'sheets:spreadsheet:create',
    'sheets:spreadsheet:write_only',
  ],
  'feishu_sheet.find': ['sheets:spreadsheet.meta:read', 'sheets:spreadsheet:read'],
  'feishu_sheet.create': [
    'sheets:spreadsheet.meta:read',
    'sheets:spreadsheet:read',
    'sheets:spreadsheet:create',
    'sheets:spreadsheet:write_only',
  ],
  'feishu_sheet.export': ['docs:document:export'],
} as const;

// ===== 必需的应用身份权限 =====

/**
 * 飞书插件运行必须开通的应用身份权限清单
 *
 * 这些权限是插件基础功能（消息接收、卡片交互、基本信息查询等）所必需的，
 * 如果缺失这些权限，插件将无法正常工作。
 *
 * 权限分类：
 * - im:message.* - 消息接收和发送
 * - im:chat.* - 群聊管理
 * - im:resource - 消息资源（图片、文件等）
 * - cardkit:card.* - 卡片交互
 * - application:application:self_manage - 应用自身权限查询（权限检查基础）
 * - contact:contact.base:readonly - 通讯录基础信息
 * - docx:document:readonly - 文档基础只读（文档链接预览等）
 *
 * 最后更新: 2026-03-03
 */
export const REQUIRED_APP_SCOPES = [
  'contact:contact.base:readonly',
  'docx:document:readonly',
  'im:chat:read',
  'im:chat:update',
  'im:message.group_at_msg:readonly',
  'im:message.p2p_msg:readonly',
  'im:message.pins:read',
  'im:message.pins:write_only',
  'im:message.reactions:read',
  'im:message.reactions:write_only',
  'im:message:readonly',
  'im:message:recall',
  'im:message:send_as_bot',
  'im:message:send_multi_users',
  'im:message:send_sys_msg',
  'im:message:update',
  'im:resource',
  'application:application:self_manage',
  'cardkit:card:write',
  'cardkit:card:read',
] as const;

/**
 * 必需应用权限类型
 */
export type RequiredAppScope = (typeof REQUIRED_APP_SCOPES)[number];

/**
 * 必需权限用途说明
 *
 * 描述每个必需权限的具体用途，帮助管理员理解为什么需要开通该权限。
 */
export const REQUIRED_SCOPE_DESCRIPTIONS: Record<RequiredAppScope, string> = {
  'contact:contact.base:readonly': '获取用户基本信息（姓名、头像）',
  'docx:document:readonly': '读取文档内容、预览文档链接',
  'im:chat:read': '读取群聊信息、获取群成员列表',
  'im:chat:update': '修改群聊设置（群名称、群公告等）',
  'im:message.group_at_msg:readonly': '接收群聊中 @ 机器人的消息',
  'im:message.p2p_msg:readonly': '接收私聊消息',
  'im:message.pins:read': '读取消息置顶状态',
  'im:message.pins:write_only': '置顶/取消置顶消息',
  'im:message.reactions:read': '读取消息表情回复',
  'im:message.reactions:write_only': '添加/删除消息表情回复',
  'im:message:readonly': '读取消息内容、历史消息',
  'im:message:recall': '↩撤回机器人发送的消息',
  'im:message:send_as_bot': '以机器人身份发送消息',
  'im:message:send_multi_users': '批量发送私聊消息',
  'im:message:send_sys_msg': '发送系统通知消息',
  'im:message:update': '更新/编辑已发送的消息',
  'im:resource': '上传/下载消息资源（图片、文件等）',
  'application:application:self_manage': '查询应用自身权限状态（诊断基础）',
  'cardkit:card:write': '创建和更新消息卡片',
  'cardkit:card:read': '读取消息卡片状态',
};

// ===== 高敏感权限 =====

/**
 * 高敏感权限清单
 *
 * 这些权限具有较高的敏感度，不应在批量授权时自动申请。
 * 用户需要明确知晓这些权限的影响后，才能手动授权。
 *
 * 权限说明：
 * - im:message.send_as_user - 以用户身份发送消息（高风险，可能被滥用发送钓鱼或垃圾消息）
 * - space:document:delete - 删除云文档
 * - calendar:calendar.event:delete - 删除日程
 * - base:table:delete - 删除多维表格数据表
 *
 * 使用场景：
 * - 批量授权时会自动过滤掉这些权限
 * - 需要这些权限的功能会单独提示用户授权
 *
 * 最后更新: 2026-03-17
 */
export const SENSITIVE_SCOPES = [
  'im:message.send_as_user',
  'space:document:delete',
  'calendar:calendar.event:delete',
  'base:table:delete',
] as const;

/**
 * 高敏感权限类型
 */
export type SensitiveScope = (typeof SENSITIVE_SCOPES)[number];

/**
 * 过滤掉高敏感权限
 *
 * 用于批量授权时排除高敏感权限，这些权限需要用户明确授权。
 *
 * @param scopes - 原始权限列表
 * @returns 过滤后的权限列表（不包含高敏感权限）
 *
 * @example
 * ```typescript
 * const allScopes = ["im:message", "im:message.send_as_user", "calendar:calendar:read"];
 * const safeScopes = filterSensitiveScopes(allScopes);
 * // 返回: ["im:message", "calendar:calendar:read"]
 * ```
 */
export function filterSensitiveScopes(scopes: string[]): string[] {
  const sensitiveSet = new Set<string>(SENSITIVE_SCOPES);
  return scopes.filter((scope) => !sensitiveSet.has(scope));
}

// ===== 统计信息 =====

/**
 * 工具动作总数: 96
 * 唯一 scope 总数: 74
 * 必需应用权限总数: 20
 * 高敏感权限总数: 4
 */
