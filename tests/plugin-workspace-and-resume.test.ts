import test from 'node:test';
import assert from 'node:assert/strict';

import { convertFolder } from '../src/messaging/converters/folder.ts';
import { buildToolResumeText, resolveResumeText } from '../src/tools/auth-resume.ts';
import {
  buildWorkspaceArtifactPath,
  resolveDownloadOutputPath,
  resolveToolWorkspaceDir,
} from '../src/tools/session-artifacts.ts';

const cfg = {
  agents: {
    defaults: {
      workspace: '/Users/admin/.openclaw/workspace',
    },
    list: [
      {
        id: 'zhenmeng',
        workspace: '/Users/admin/.openclaw/workspace-zhenmeng',
      },
    ],
  },
};

test('resolveToolWorkspaceDir prefers the active agent workspace', () => {
  const ticket = { agentId: 'zhenmeng' };
  assert.equal(resolveToolWorkspaceDir(cfg as never, ticket), '/Users/admin/.openclaw/workspace-zhenmeng');
});

test('buildWorkspaceArtifactPath places files inside the active workspace', () => {
  const ticket = { agentId: 'zhenmeng' };
  const output = buildWorkspaceArtifactPath({
    cfg: cfg as never,
    ticket,
    prefix: 'im-resource',
    extension: '.xlsx',
    preferredFileName: '3.1-3.15日客诉数据源.xlsx',
  });

  assert.match(output.absolutePath, /^\/Users\/admin\/\.openclaw\/workspace-zhenmeng\/\.openclaw\/artifacts\/feishu\//);
  assert.match(output.absolutePath, /\.xlsx$/);
  assert.equal(output.workspacePath?.startsWith('.openclaw/artifacts/feishu/'), true);
  assert.equal(output.absolutePath.includes('/tmp/openclaw/'), false);
});

test('resolveDownloadOutputPath auto-generates a safe workspace path when omitted', () => {
  const ticket = { agentId: 'zhenmeng' };
  const output = resolveDownloadOutputPath({
    cfg: cfg as never,
    ticket,
    prefix: 'drive-file',
    extension: '.pdf',
    preferredFileName: '周报.pdf',
  });

  assert.match(output.absolutePath, /^\/Users\/admin\/\.openclaw\/workspace-zhenmeng\/\.openclaw\/artifacts\/feishu\//);
  assert.match(output.absolutePath, /\.pdf$/);
});

test('resolveDownloadOutputPath resolves relative output paths inside the workspace', () => {
  const ticket = { agentId: 'zhenmeng' };
  const output = resolveDownloadOutputPath({
    cfg: cfg as never,
    ticket,
    prefix: 'drive-file',
    outputPath: 'exports/report.xlsx',
  });

  assert.equal(output.absolutePath, '/Users/admin/.openclaw/workspace-zhenmeng/exports/report.xlsx');
  assert.equal(output.workspacePath, 'exports/report.xlsx');
});

test('resolveDownloadOutputPath rejects relative paths that escape the workspace', () => {
  const ticket = { agentId: 'zhenmeng' };

  assert.throws(
    () =>
      resolveDownloadOutputPath({
        cfg: cfg as never,
        ticket,
        prefix: 'drive-file',
        outputPath: '../outside/report.xlsx',
      }),
    /must stay within the current workspace/,
  );
});

test('buildToolResumeText carries the pending tool call context', () => {
  const text = buildToolResumeText('feishu_drive_file', {
    action: 'download',
    file_token: 'boxcn123',
  });

  assert.match(text, /feishu_drive_file/);
  assert.match(text, /"action": "download"/);
  assert.match(text, /"file_token": "boxcn123"/);
  assert.match(text, /System: 飞书授权已完成/);
});

test('resolveResumeText prefers the tool-specific resume context', () => {
  const resumeText = resolveResumeText(
    { resumeText: '请直接恢复工具调用。' },
    '我已完成飞书账号授权，请继续执行之前的操作。',
  );

  assert.equal(resumeText, '请直接恢复工具调用。');
});

test('convertFolder keeps folder placeholders without treating them as downloadable files', () => {
  const result = convertFolder(
    JSON.stringify({
      file_key: 'file_v3_01100_b5a280c5-d69a-4b5b-bfd7-1c0d116824bg',
      file_name: 'hr-analysis',
    }),
    {} as never,
  );

  assert.equal(result.content, '<folder key="file_v3_01100_b5a280c5-d69a-4b5b-bfd7-1c0d116824bg" name="hr-analysis"/>');
  assert.deepEqual(result.resources, []);
});
