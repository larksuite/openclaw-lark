/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Media resolution and payload building for inbound Feishu messages.
 *
 * Downloads media files based on ResourceDescriptors extracted during
 * the content converter phase, and builds the payload object spread
 * into the agent envelope.
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import type { FeishuMediaInfo, ResourceDescriptor } from '../types';
import { LarkClient } from '../../core/lark-client';
import { downloadMessageResourceFeishu } from '../outbound/media';

// ---------------------------------------------------------------------------
// Resource-descriptor-based download
// ---------------------------------------------------------------------------

/**
 * Download media files based on pre-extracted ResourceDescriptors from
 * the converter phase.
 */
export async function downloadResources(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  resources: ResourceDescriptor[];
  maxBytes: number;
  log?: (msg: string) => void;
  accountId?: string;
}): Promise<FeishuMediaInfo[]> {
  const { cfg, messageId, resources, maxBytes, log, accountId } = params;

  if (resources.length === 0) return [];

  const out: FeishuMediaInfo[] = [];
  const core = LarkClient.runtime;

  for (const res of resources) {
    try {
      const resourceType = res.type === 'image' ? 'image' : 'file';
      const result = await downloadMessageResourceFeishu({
        cfg,
        messageId,
        fileKey: res.fileKey,
        type: resourceType,
        accountId,
      });

      let contentType = result.contentType;
      if (!contentType) {
        contentType = await core.media.detectMime({ buffer: result.buffer });
      }

      const fileName = result.fileName || res.fileName;
      const saved = await core.channel.media.saveMediaBuffer(result.buffer, contentType, 'inbound', maxBytes, fileName);

      const placeholder = inferPlaceholderFromType(res.type);
      out.push({
        path: saved.path,
        contentType: saved.contentType,
        placeholder,
        fileKey: res.fileKey,
        resourceType: res.type,
      });

      log?.(`feishu: downloaded ${res.type} resource ${res.fileKey}, saved to ${saved.path}`);
    } catch (err) {
      log?.(`feishu: failed to download ${res.type} resource ${res.fileKey}: ${String(err)}`);
    }
  }

  return out;
}

function inferPlaceholderFromType(type: ResourceDescriptor['type']): string {
  switch (type) {
    case 'image':
      return '<media:image>';
    case 'file':
      return '<media:document>';
    case 'audio':
      return '<media:audio>';
    case 'video':
      return '<media:video>';
    case 'sticker':
      return '<media:sticker>';
  }
}

// ---------------------------------------------------------------------------
// Media payload builder
// ---------------------------------------------------------------------------

export function buildFeishuMediaPayload(mediaList: FeishuMediaInfo[]): {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
} {
  const first = mediaList[0];
  const mediaPaths = mediaList.map((m) => m.path);
  const mediaTypes = mediaList.map((m) => m.contentType).filter(Boolean) as string[];

  return {
    MediaPath: first?.path,
    MediaType: first?.contentType,
    MediaUrl: first?.path,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
  };
}
