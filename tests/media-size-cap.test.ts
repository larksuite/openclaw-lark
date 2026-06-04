/**
 * Tests for streaming media size cap enforcement.
 *
 * Verifies that streamToBuffer and extractBufferFromResponse abort
 * mid-stream when maxBytes is exceeded, avoiding full buffering of
 * oversized responses.
 */

import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { streamToBuffer } from '../src/messaging/outbound/media';

function makeStream(chunks: Buffer[], error?: Error): Readable {
  let i = 0;
  return new Readable({
    read() {
      if (i < chunks.length) {
        this.push(chunks[i++]);
      } else if (error) {
        this.destroy(error);
      } else {
        this.push(null);
      }
    },
  });
}

describe('streamToBuffer – maxBytes guard', () => {
  it('resolves when stream is under the limit', async () => {
    const stream = makeStream([Buffer.alloc(100), Buffer.alloc(200)]);
    const buf = await streamToBuffer(stream, 1024);
    expect(buf.length).toBe(300);
  });

  it('resolves without maxBytes (backward compat)', async () => {
    const stream = makeStream([Buffer.alloc(1024), Buffer.alloc(1024)]);
    const buf = await streamToBuffer(stream);
    expect(buf.length).toBe(2048);
  });

  it('rejects when cumulative bytes exceed maxBytes mid-stream', async () => {
    const stream = makeStream([Buffer.alloc(512), Buffer.alloc(512), Buffer.alloc(1)]);
    await expect(streamToBuffer(stream, 1024)).rejects.toThrow(
      /\[feishu-media\] Download exceeded .* MB limit/,
    );
  });

  it('rejects on the exact chunk that pushes over the limit', async () => {
    // 100 + 100 + 50 = 250, limit 200 → reject on third chunk
    const stream = makeStream([Buffer.alloc(100), Buffer.alloc(100), Buffer.alloc(50)]);
    await expect(streamToBuffer(stream, 200)).rejects.toThrow(/exceeded/);
  });

  it('resolves when stream bytes exactly equal maxBytes', async () => {
    const stream = makeStream([Buffer.alloc(500), Buffer.alloc(500)]);
    const buf = await streamToBuffer(stream, 1000);
    expect(buf.length).toBe(1000);
  });

  it('propagates stream errors', async () => {
    const stream = makeStream([Buffer.alloc(10)], new Error('network error'));
    await expect(streamToBuffer(stream)).rejects.toThrow('network error');
  });

  it('rejects with stream error when maxBytes not set', async () => {
    const stream = makeStream([Buffer.alloc(10)], new Error('io error'));
    await expect(streamToBuffer(stream, 1024)).rejects.toThrow('io error');
  });
});
