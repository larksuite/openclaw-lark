/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Resolve workspace-local artifact paths for tool downloads.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
import type { LarkTicket } from '../core/lark-ticket';

interface AgentWorkspaceConfig {
  agents?: {
    defaults?: {
      workspace?: string;
    };
    list?: Array<{
      id?: string;
      workspace?: string;
    }>;
  };
}

export interface WorkspaceArtifactPath {
  workspaceDir: string;
  absolutePath: string;
  workspacePath?: string;
}

function sanitizePathSegment(value: string): string {
  const normalized = value
    .normalize('NFKC')
    .replace(/[\/\\]/g, '-')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();

  return normalized || 'artifact';
}

function normalizeExtension(extension?: string, preferredFileName?: string): string {
  if (extension && extension.trim()) {
    return extension.startsWith('.') ? extension : `.${extension}`;
  }

  const nameExt = preferredFileName ? path.extname(preferredFileName) : '';
  return nameExt || '';
}

function buildArtifactFileName(params: {
  prefix: string;
  extension?: string;
  preferredFileName?: string;
}): string {
  const ext = normalizeExtension(params.extension, params.preferredFileName);
  const rawBaseName = params.preferredFileName
    ? path.basename(params.preferredFileName, path.extname(params.preferredFileName))
    : params.prefix;
  const baseName = sanitizePathSegment(rawBaseName);

  return `${baseName}-${randomUUID().slice(0, 8)}${ext}`;
}

function toWorkspacePath(workspaceDir: string, absolutePath: string): string | undefined {
  const relativePath = path.relative(workspaceDir, absolutePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return undefined;
  }

  return relativePath.split(path.sep).join(path.posix.sep);
}

export function resolveToolWorkspaceDir(cfg: ClawdbotConfig, ticket?: Pick<LarkTicket, 'agentId'>): string {
  const agentCfg = cfg as ClawdbotConfig & AgentWorkspaceConfig;
  const defaultWorkspace = agentCfg.agents?.defaults?.workspace;

  if (!defaultWorkspace) {
    throw new Error('Missing agents.defaults.workspace in config');
  }

  const agentId = ticket?.agentId?.trim();
  if (!agentId || agentId === 'main' || agentId === 'default') {
    return defaultWorkspace;
  }

  const listedWorkspace = agentCfg.agents?.list?.find((entry) => entry.id === agentId)?.workspace;
  if (listedWorkspace) {
    return listedWorkspace;
  }

  const parsed = path.parse(defaultWorkspace);
  return path.join(parsed.dir, `${parsed.base}-${sanitizePathSegment(agentId)}`);
}

export function buildWorkspaceArtifactPath(params: {
  cfg: ClawdbotConfig;
  ticket?: Pick<LarkTicket, 'agentId'>;
  prefix: string;
  extension?: string;
  preferredFileName?: string;
}): WorkspaceArtifactPath {
  const workspaceDir = resolveToolWorkspaceDir(params.cfg, params.ticket);
  const fileName = buildArtifactFileName(params);
  const absolutePath = path.join(workspaceDir, '.openclaw', 'artifacts', 'feishu', fileName);

  return {
    workspaceDir,
    absolutePath,
    workspacePath: toWorkspacePath(workspaceDir, absolutePath),
  };
}

export function resolveDownloadOutputPath(params: {
  cfg: ClawdbotConfig;
  ticket?: Pick<LarkTicket, 'agentId'>;
  prefix: string;
  extension?: string;
  preferredFileName?: string;
  outputPath?: string;
}): WorkspaceArtifactPath {
  const workspaceDir = resolveToolWorkspaceDir(params.cfg, params.ticket);

  if (!params.outputPath) {
    return buildWorkspaceArtifactPath(params);
  }

  const absolutePath = path.isAbsolute(params.outputPath)
    ? params.outputPath
    : path.resolve(workspaceDir, params.outputPath);
  const workspacePath = toWorkspacePath(workspaceDir, absolutePath);

  if (!path.isAbsolute(params.outputPath) && !workspacePath) {
    throw new Error('Relative output_path must stay within the current workspace');
  }

  return {
    workspaceDir,
    absolutePath,
    workspacePath,
  };
}

export function extractFilenameFromContentDisposition(value?: string): string | undefined {
  if (!value) return undefined;

  const encodedMatch = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (encodedMatch?.[1]) {
    try {
      return sanitizePathSegment(decodeURIComponent(encodedMatch[1]));
    } catch {
      return sanitizePathSegment(encodedMatch[1]);
    }
  }

  const plainMatch = value.match(/filename="?([^";]+)"?/i);
  if (plainMatch?.[1]) {
    return sanitizePathSegment(plainMatch[1]);
  }

  return undefined;
}
