/**
 * Tests for src/card/tool-use-display.ts
 *
 * Covers: normalizeToolUseDisplay data source priority,
 * tool descriptor resolution, path sanitization, duration/error display,
 * result-detail gating, and buildToolUseTitleSuffix i18n.
 */

import { describe, expect, it } from 'vitest';
import type { ToolUseTraceStep } from '../src/card/tool-use-trace-store';
import { buildToolUseTitleSuffix, normalizeToolUseDisplay } from '../src/card/tool-use-display';

// ---------------------------------------------------------------------------
// Helper: build a minimal ToolUseTraceStep
// ---------------------------------------------------------------------------

function traceStep(overrides: Partial<ToolUseTraceStep> & { toolName: string }): ToolUseTraceStep {
  return {
    id: '1',
    seq: 1,
    status: 'success',
    startedAt: Date.now(),
    finishedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Data source priority
// ---------------------------------------------------------------------------

describe('normalizeToolUseDisplay data source priority', () => {
  it('uses traceSteps as the source of truth', () => {
    const traceSteps: ToolUseTraceStep[] = [traceStep({ toolName: 'read', params: { file_path: '/a.ts' } })];

    const result = normalizeToolUseDisplay({ traceSteps });
    expect(result.stepCount).toBe(1);
    expect(result.steps[0]!.title).toContain('Read');
  });

  it('returns empty result when no sources', () => {
    const result = normalizeToolUseDisplay({});
    expect(result.stepCount).toBe(0);
    expect(result.steps).toEqual([]);
    expect(result.content).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Tool descriptor resolution
// ---------------------------------------------------------------------------

describe('tool descriptor resolution', () => {
  const toolTests: Array<{ toolName: string; expectedTitle: string }> = [
    { toolName: 'read', expectedTitle: 'Read' },
    { toolName: 'write', expectedTitle: 'Edit' },
    { toolName: 'edit', expectedTitle: 'Edit' },
    { toolName: 'grep', expectedTitle: 'Search text' },
    { toolName: 'glob', expectedTitle: 'Search files' },
    { toolName: 'bash', expectedTitle: 'Run command' },
    { toolName: 'exec', expectedTitle: 'Run command' },
    { toolName: 'web_search', expectedTitle: 'Search web' },
    { toolName: 'web_fetch', expectedTitle: 'Fetch web page' },
    { toolName: 'agent', expectedTitle: 'Run sub-agent' },
    { toolName: 'browser', expectedTitle: 'Browser' },
  ];

  for (const { toolName, expectedTitle } of toolTests) {
    it(`resolves ${toolName} → ${expectedTitle}`, () => {
      const result = normalizeToolUseDisplay({
        traceSteps: [traceStep({ toolName, params: { description: 'test' } })],
      });
      expect(result.steps[0]!.title).toContain(expectedTitle);
    });
  }

  it('humanizes unknown tool names', () => {
    const result = normalizeToolUseDisplay({
      traceSteps: [traceStep({ toolName: 'custom_tool', params: { x: 1 } })],
    });
    expect(result.steps[0]!.title).toContain('Custom tool');
  });
});

// ---------------------------------------------------------------------------
// Path sanitization
// ---------------------------------------------------------------------------

describe('path sanitization', () => {
  it('shows only basename when showFullPaths is false', () => {
    const result = normalizeToolUseDisplay({
      traceSteps: [traceStep({ toolName: 'read', params: { file_path: '/Users/foo/project/src/main.ts' } })],
      showFullPaths: false,
    });
    expect(result.steps[0]!.detail).toBe('main.ts');
  });

  it('shows full path when showFullPaths is true', () => {
    const result = normalizeToolUseDisplay({
      traceSteps: [traceStep({ toolName: 'read', params: { file_path: '/Users/foo/project/src/main.ts' } })],
      showFullPaths: true,
    });
    expect(result.steps[0]!.detail).toContain('/Users/foo/project/src/main.ts');
  });
});

// ---------------------------------------------------------------------------
// Duration display
// ---------------------------------------------------------------------------

describe('duration display', () => {
  it('shows milliseconds for fast operations', () => {
    const result = normalizeToolUseDisplay({
      traceSteps: [traceStep({ toolName: 'read', durationMs: 42, params: { file_path: '/a.ts' } })],
    });
    expect(result.steps[0]!.title).toContain('42 ms');
  });

  it('shows seconds for slower operations', () => {
    const result = normalizeToolUseDisplay({
      traceSteps: [traceStep({ toolName: 'bash', durationMs: 3500, params: { command: 'build' } })],
    });
    expect(result.steps[0]!.title).toContain('3.5 s');
  });
});

// ---------------------------------------------------------------------------
// Error display
// ---------------------------------------------------------------------------

describe('error display', () => {
  it('stores error info in a dedicated error block without icon color metadata', () => {
    const result = normalizeToolUseDisplay({
      traceSteps: [traceStep({ toolName: 'bash', error: 'exit code 1', status: 'error', params: { command: 'test' } })],
    });
    expect(result.steps[0]!.status).toBe('error');
    expect(result.steps[0]).not.toHaveProperty('iconColor');
    expect(result.steps[0]!.errorBlock?.language).toBe('text');
    expect(result.steps[0]!.errorBlock?.content).toBe('exit code 1');
  });

  it('redacts inline secrets in command error blocks', () => {
    const result = normalizeToolUseDisplay({
      traceSteps: [
        traceStep({
          toolName: 'bash',
          error: `TOKEN=supersecret Authorization: Bearer abc123`,
          status: 'error',
          params: { command: 'test' },
        }),
      ],
    });

    expect(result.steps[0]!.errorBlock?.content).toContain('TOKEN=[redacted]');
    expect(result.steps[0]!.errorBlock?.content).toContain('Authorization: Bearer [redacted]');
    expect(result.steps[0]!.errorBlock?.content).not.toContain('supersecret');
    expect(result.steps[0]!.errorBlock?.content).not.toContain('abc123');
  });
});

// ---------------------------------------------------------------------------
// Result detail gating
// ---------------------------------------------------------------------------

describe('result detail gating', () => {
  it('hides result detail when showResultDetails is false', () => {
    const result = normalizeToolUseDisplay({
      traceSteps: [
        traceStep({
          toolName: 'bash',
          params: { command: 'pnpm test' },
          result: '3 tests passed',
          status: 'success',
        }),
      ],
      showResultDetails: false,
    });

    expect(result.steps[0]!.resultBlock).toBeUndefined();
  });

  it('shows string result detail as a text code block when showResultDetails is true', () => {
    const result = normalizeToolUseDisplay({
      traceSteps: [
        traceStep({
          toolName: 'bash',
          params: { command: 'pnpm test' },
          result: '3 tests passed',
          status: 'success',
        }),
      ],
      showResultDetails: true,
    });

    expect(result.steps[0]!.status).toBe('success');
    expect(result.steps[0]).not.toHaveProperty('iconColor');
    expect(result.steps[0]!.resultBlock?.language).toBe('text');
    expect(result.steps[0]!.resultBlock?.content).toBe('3 tests passed');
  });

  it('formats object results as pretty json blocks', () => {
    const result = normalizeToolUseDisplay({
      traceSteps: [
        traceStep({
          toolName: 'bash',
          params: { command: 'pnpm test' },
          result: { status: 'completed', exitCode: 0, durationMs: 1715 },
          status: 'success',
        }),
      ],
      showResultDetails: true,
    });

    expect(result.steps[0]!.resultBlock?.language).toBe('json');
    expect(result.steps[0]!.resultBlock?.content).toContain('"status": "completed"');
    expect(result.steps[0]!.resultBlock?.content).toContain('"exitCode": 0');
  });

  it('does not add a second display-layer truncation for long command details', () => {
    const longCommand = `bash -lc "${'echo very-long-token '.repeat(20).trim()}"`;

    const result = normalizeToolUseDisplay({
      traceSteps: [
        traceStep({
          toolName: 'bash',
          params: { command: longCommand },
          status: 'success',
        }),
      ],
    });

    expect(result.steps[0]!.detail).toContain('bash -lc');
    expect(result.steps[0]).not.toHaveProperty('detailStyle');
    expect(result.steps[0]!.detail!.length).toBeGreaterThan(144);
    expect(result.steps[0]!.detail).not.toContain('...');
  });

  it('redacts inline secrets in command details', () => {
    const result = normalizeToolUseDisplay({
      traceSteps: [
        traceStep({
          toolName: 'bash',
          params: {
            command: `TOKEN=supersecret curl -H 'Authorization: Bearer abc123' https://example.com`,
          },
          status: 'success',
        }),
      ],
    });

    expect(result.steps[0]!.detail).toContain('TOKEN=[redacted]');
    expect(result.steps[0]!.detail).toContain('Authorization: Bearer [redacted]');
    expect(result.steps[0]!.detail).not.toContain('supersecret');
    expect(result.steps[0]!.detail).not.toContain('abc123');
  });

  it('preserves shell redirect syntax in command details', () => {
    const result = normalizeToolUseDisplay({
      traceSteps: [
        traceStep({
          toolName: 'bash',
          params: {
            command: 'cat < input.txt > output.txt',
          },
          status: 'success',
        }),
      ],
    });

    expect(result.steps[0]!.detail).toBe('cat < input.txt > output.txt');
  });

  it('redacts inline secrets in command result blocks', () => {
    const result = normalizeToolUseDisplay({
      traceSteps: [
        traceStep({
          toolName: 'bash',
          params: { command: 'pnpm test' },
          result: `TOKEN=supersecret Authorization: Bearer abc123`,
          status: 'success',
        }),
      ],
      showResultDetails: true,
    });

    expect(result.steps[0]!.resultBlock?.content).toContain('TOKEN=[redacted]');
    expect(result.steps[0]!.resultBlock?.content).toContain('Authorization: Bearer [redacted]');
    expect(result.steps[0]!.resultBlock?.content).not.toContain('supersecret');
    expect(result.steps[0]!.resultBlock?.content).not.toContain('abc123');
  });
});

// ---------------------------------------------------------------------------
// buildToolUseTitleSuffix
// ---------------------------------------------------------------------------

describe('buildToolUseTitleSuffix', () => {
  it('singular step', () => {
    const suffix = buildToolUseTitleSuffix({ stepCount: 1 });
    expect(suffix.en).toBe('Show 1 step');
    expect(suffix.zh).toBe('查看 1 个步骤');
  });

  it('plural steps', () => {
    const suffix = buildToolUseTitleSuffix({ stepCount: 5 });
    expect(suffix.en).toBe('Show 5 steps');
    expect(suffix.zh).toBe('查看 5 个步骤');
  });
});

// ---------------------------------------------------------------------------
// Content output format
// ---------------------------------------------------------------------------

describe('content format', () => {
  it('generates markdown list with title and detail', () => {
    const result = normalizeToolUseDisplay({
      traceSteps: [
        traceStep({ toolName: 'read', params: { file_path: '/a.ts' } }),
        traceStep({ toolName: 'grep', params: { pattern: 'TODO' } }),
      ],
    });
    const lines = result.content.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^- Read/);
    expect(lines[1]).toMatch(/^- Search text/);
  });
});
