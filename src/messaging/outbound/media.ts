/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Media handling for the Lark/Feishu channel plugin.
 *
 * Provides functions for downloading images and file resources from
 * Feishu messages, uploading media to the Feishu IM storage, and
 * sending image / file messages to chats.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import * as dns from 'node:dns/promises';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import { LarkClient } from '../../core/lark-client';
import { normalizeFeishuTarget, resolveReceiveIdType } from '../../core/targets';
import {
  isLocalMediaPath,
  normalizeMediaUrlInput,
  resolveFileNameFromMediaUrl,
  safeFileUrlToPath,
  validateLocalMediaRoots,
} from './media-url-utils';
import { larkLogger } from '../../core/lark-logger';

const log = larkLogger('outbound/media');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of downloading an image from Feishu.
 */
export interface DownloadImageResult {
  /** The raw image bytes. */
  buffer: Buffer;
  /** The MIME type of the image (e.g. "image/png"), if known. */
  contentType?: string;
}

/**
 * Result of downloading a message resource (image or file) from Feishu.
 */
export interface DownloadMessageResourceResult {
  /** The raw file bytes. */
  buffer: Buffer;
  /** The MIME type of the resource, if known. */
  contentType?: string;
  /** The original file name, if available. */
  fileName?: string;
}

/**
 * Result of uploading an image to Feishu.
 */
export interface UploadImageResult {
  /** The image_key assigned by Feishu, used to reference the image. */
  imageKey: string;
}

/**
 * Result of uploading a file to Feishu.
 */
export interface UploadFileResult {
  /** The file_key assigned by Feishu, used to reference the file. */
  fileKey: string;
}

/**
 * Result of sending a media (image or file) message.
 */
export interface SendMediaResult {
  /** Platform-assigned message ID. */
  messageId: string;
  /** Chat ID where the media was sent. */
  chatId: string;
}

// ---------------------------------------------------------------------------
// Response extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract a Buffer from various SDK response formats.
 *
 * The Feishu Node SDK can return binary data in several shapes depending
 * on the runtime environment and SDK version:
 *   - A Buffer directly
 *   - An ArrayBuffer
 *   - A response object with a `.data` property
 *   - A response object with `.getReadableStream()`
 *   - A response object with `.writeFile(path)`
 *   - An async iterable / iterator
 *   - A Node.js Readable stream
 *
 * This helper normalises all of those into a single Buffer.
 */
async function extractBufferFromResponse(response: unknown): Promise<{ buffer: Buffer; contentType?: string }> {
  // Direct Buffer
  if (Buffer.isBuffer(response)) {
    return { buffer: response };
  }

  // ArrayBuffer
  if (response instanceof ArrayBuffer) {
    return { buffer: Buffer.from(response) };
  }

  // Null / undefined guard
  if (response == null) {
    throw new Error('[feishu-media] Received null/undefined response');
  }

  const resp = response as Record<string, any>;
  const contentType: string | undefined = resp.headers?.['content-type'] ?? resp.contentType ?? undefined;

  // Response with .data as Buffer or ArrayBuffer
  if (resp.data != null) {
    if (Buffer.isBuffer(resp.data)) {
      return { buffer: resp.data, contentType };
    }
    if (resp.data instanceof ArrayBuffer) {
      return { buffer: Buffer.from(resp.data), contentType };
    }
    // .data might itself be a readable stream
    if (typeof resp.data.pipe === 'function') {
      const buf = await streamToBuffer(resp.data as Readable);
      return { buffer: buf, contentType };
    }
  }

  // Response with .getReadableStream()
  if (typeof resp.getReadableStream === 'function') {
    const stream = await resp.getReadableStream();
    const buf = await streamToBuffer(stream);
    return { buffer: buf, contentType };
  }

  // Response with .writeFile(path) -- write to a temp file and read back.
  if (typeof resp.writeFile === 'function') {
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `feishu-media-${Date.now()}`);
    try {
      await resp.writeFile(tmpFile);
      const buf = fs.readFileSync(tmpFile);
      return { buffer: buf, contentType };
    } finally {
      // Clean up the temp file.
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // Ignore cleanup errors.
      }
    }
  }

  // Async iterable / iterator (e.g. response body chunks)
  if (typeof (resp as any)[Symbol.asyncIterator] === 'function' || typeof (resp as any).next === 'function') {
    const chunks: Buffer[] = [];
    const iterable =
      typeof (resp as any)[Symbol.asyncIterator] === 'function'
        ? (resp as AsyncIterable<Uint8Array>)
        : asyncIteratorToIterable(resp as AsyncIterator<Uint8Array>);

    for await (const chunk of iterable) {
      chunks.push(Buffer.from(chunk));
    }
    return { buffer: Buffer.concat(chunks), contentType };
  }

  // Node.js Readable stream
  if (typeof resp.pipe === 'function') {
    const buf = await streamToBuffer(resp as Readable);
    return { buffer: buf, contentType };
  }

  throw new Error('[feishu-media] Unable to extract binary data from response: unrecognised format');
}

/**
 * Consume a Readable stream into a Buffer.
 */
function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer | Uint8Array) => {
      chunks.push(Buffer.from(chunk));
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/**
 * Wrap an AsyncIterator into an AsyncIterable.
 */
async function* asyncIteratorToIterable<T>(iterator: AsyncIterator<T>): AsyncIterable<T> {
  while (true) {
    const { value, done } = await iterator.next();
    if (done) break;
    yield value;
  }
}

// ---------------------------------------------------------------------------
// downloadMessageResourceFeishu
// ---------------------------------------------------------------------------

/**
 * Download a resource (image or file) attached to a specific message.
 *
 * @param params.cfg       - Plugin configuration.
 * @param params.messageId - The message the resource belongs to.
 * @param params.fileKey   - The file_key or image_key of the resource.
 * @param params.type      - Whether the resource is an "image" or "file".
 * @param params.accountId - Optional account identifier.
 * @returns The resource buffer, content type, and file name.
 */
export async function downloadMessageResourceFeishu(params: {
  cfg: OpenClawConfig;
  messageId: string;
  fileKey: string;
  type: 'image' | 'file';
  accountId?: string;
}): Promise<DownloadMessageResourceResult> {
  const { cfg, messageId, fileKey, type, accountId } = params;

  const client = LarkClient.fromCfg(cfg, accountId).sdk;

  const response = await client.im.messageResource.get({
    path: {
      message_id: messageId,
      file_key: fileKey,
    },
    params: {
      type,
    },
  });

  const { buffer, contentType } = await extractBufferFromResponse(response);

  // Attempt to extract file name from response headers.
  let fileName: string | undefined;
  if (response && typeof response === 'object') {
    const resp = response as Record<string, any>;
    const disposition = resp.headers?.['content-disposition'] ?? resp.headers?.['Content-Disposition'];
    if (typeof disposition === 'string') {
      const match = disposition.match(/filename[*]?=(?:UTF-8'')?["']?([^"';\n]+)/i);
      if (match) {
        fileName = decodeURIComponent(match[1].trim());
      }
    }
  }

  return { buffer, contentType, fileName };
}

// ---------------------------------------------------------------------------
// uploadImageLark
// ---------------------------------------------------------------------------

/**
 * Upload an image to Feishu IM storage.
 *
 * Accepts either a Buffer containing the raw image bytes or a file
 * system path to read from.
 *
 * @param params.cfg       - Plugin configuration.
 * @param params.image     - A Buffer or local file path for the image.
 * @param params.imageType - The image usage type: "message" (default) or "avatar".
 * @param params.accountId - Optional account identifier.
 * @returns The assigned image_key.
 */
export async function uploadImageLark(params: {
  cfg: OpenClawConfig;
  image: Buffer | string;
  imageType?: 'message' | 'avatar';
  accountId?: string;
}): Promise<UploadImageResult> {
  const { cfg, image, imageType = 'message', accountId } = params;

  const client = LarkClient.fromCfg(cfg, accountId).sdk;
  const imageStream = Buffer.isBuffer(image) ? Readable.from(image) : fs.createReadStream(image);

  const response = await client.im.image.create({
    data: { image_type: imageType, image: imageStream as any },
  });

  const imageKey = (response as any)?.data?.image_key ?? (response as any)?.image_key;
  if (!imageKey) {
    throw new Error(
      '[feishu-media] Image upload failed: no image_key in response. ' +
        `Check that the image is a valid format (JPEG/PNG/GIF/BMP/WEBP). ` +
        `Response: ${JSON.stringify(response).slice(0, 200)}`,
    );
  }

  return { imageKey };
}

// ---------------------------------------------------------------------------
// uploadFileLark
// ---------------------------------------------------------------------------

/**
 * Upload a file to Feishu IM storage.
 *
 * @param params.cfg       - Plugin configuration.
 * @param params.file      - A Buffer or local file path.
 * @param params.fileName  - The display name of the file.
 * @param params.fileType  - Feishu file type: "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream".
 * @param params.duration  - Duration in milliseconds (for audio/video files).
 * @param params.accountId - Optional account identifier.
 * @returns The assigned file_key.
 */
export async function uploadFileLark(params: {
  cfg: OpenClawConfig;
  file: Buffer | string;
  fileName: string;
  fileType: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';
  duration?: number;
  accountId?: string;
}): Promise<UploadFileResult> {
  const { cfg, file, fileName, fileType, duration, accountId } = params;

  const client = LarkClient.fromCfg(cfg, accountId).sdk;
  const fileStream = Buffer.isBuffer(file) ? Readable.from(file) : fs.createReadStream(file);

  const response = await client.im.file.create({
    data: {
      file_type: fileType,
      file_name: fileName,
      file: fileStream,
      ...(duration !== undefined ? { duration: String(duration) } : {}),
    } as any,
  });

  const fileKey = (response as any)?.data?.file_key ?? (response as any)?.file_key;
  if (!fileKey) {
    throw new Error(
      `[feishu-media] File upload failed: no file_key in response for "${fileName}" (type=${fileType}). ` +
        `Response: ${JSON.stringify(response).slice(0, 200)}`,
    );
  }

  return { fileKey };
}

// ---------------------------------------------------------------------------
// Shared media message sender
// ---------------------------------------------------------------------------

/**
 * Unified media message sender — handles both reply and create paths for
 * image / file / audio `msg_type` values.
 *
 * Mirrors {@link sendImMessage} in `deliver.ts` (which covers "post" and
 * "interactive"), extracted here to avoid a cross-module dependency.
 */
async function sendMediaMessage(params: {
  client: ReturnType<typeof LarkClient.fromCfg>['sdk'];
  to: string;
  content: string;
  msgType: 'image' | 'file' | 'audio' | 'media';
  replyToMessageId?: string;
  replyInThread?: boolean;
}): Promise<SendMediaResult> {
  const { client, to, content, msgType, replyToMessageId, replyInThread } = params;

  if (replyToMessageId) {
    const response = await client.im.message.reply({
      path: { message_id: replyToMessageId },
      data: { content, msg_type: msgType, reply_in_thread: replyInThread },
    });
    return {
      messageId: response?.data?.message_id ?? '',
      chatId: response?.data?.chat_id ?? '',
    };
  }

  const target = normalizeFeishuTarget(to);
  if (!target) {
    throw new Error(
      `[feishu-media] Cannot send ${msgType} message: "${to}" is not a valid target. ` +
        `Expected a chat_id (oc_*), open_id (ou_*), or user_id.`,
    );
  }

  const receiveIdType = resolveReceiveIdType(target);
  const response = await client.im.message.create({
    params: { receive_id_type: receiveIdType as any },
    data: { receive_id: target, msg_type: msgType, content },
  });

  return {
    messageId: response?.data?.message_id ?? '',
    chatId: response?.data?.chat_id ?? '',
  };
}

// ---------------------------------------------------------------------------
// sendImageLark
// ---------------------------------------------------------------------------

/**
 * Send an image message to a chat or user.
 *
 * @param params.cfg              - Plugin configuration.
 * @param params.to               - Target identifier.
 * @param params.imageKey         - The image_key from a previous upload.
 * @param params.replyToMessageId - Optional message ID for threaded reply.
 * @param params.replyInThread    - When true, reply appears in thread.
 * @param params.accountId        - Optional account identifier.
 * @returns The send result.
 */
export async function sendImageLark(params: {
  cfg: OpenClawConfig;
  to: string;
  imageKey: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  accountId?: string;
}): Promise<SendMediaResult> {
  const { cfg, to, imageKey, replyToMessageId, replyInThread, accountId } = params;
  log.info(`sendImageLark: target=${to}, imageKey=${imageKey}`);

  const client = LarkClient.fromCfg(cfg, accountId).sdk;
  const content = JSON.stringify({ image_key: imageKey });
  return sendMediaMessage({ client, to, content, msgType: 'image', replyToMessageId, replyInThread });
}

// ---------------------------------------------------------------------------
// sendFileLark
// ---------------------------------------------------------------------------

/**
 * Send a file message to a chat or user.
 *
 * @param params.cfg              - Plugin configuration.
 * @param params.to               - Target identifier.
 * @param params.fileKey          - The file_key from a previous upload.
 * @param params.replyToMessageId - Optional message ID for threaded reply.
 * @param params.replyInThread    - When true, reply appears in thread.
 * @param params.accountId        - Optional account identifier.
 * @returns The send result.
 */
export async function sendFileLark(params: {
  cfg: OpenClawConfig;
  to: string;
  fileKey: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  accountId?: string;
}): Promise<SendMediaResult> {
  const { cfg, to, fileKey, replyToMessageId, replyInThread, accountId } = params;
  log.info(`sendFileLark: target=${to}, fileKey=${fileKey}`);

  const client = LarkClient.fromCfg(cfg, accountId).sdk;
  const content = JSON.stringify({ file_key: fileKey });
  return sendMediaMessage({ client, to, content, msgType: 'file', replyToMessageId, replyInThread });
}

// ---------------------------------------------------------------------------
// sendVideoLark
// ---------------------------------------------------------------------------

/**
 * Send a video message to a chat or user.
 *
 * Uses `msg_type: "media"` so Feishu renders the message as a playable
 * video instead of a file attachment.
 *
 * @param params.cfg              - Plugin configuration.
 * @param params.to               - Target identifier.
 * @param params.fileKey          - The file_key from a previous upload.
 * @param params.replyToMessageId - Optional message ID for threaded reply.
 * @param params.replyInThread    - When true, reply appears in thread.
 * @param params.accountId        - Optional account identifier.
 * @returns The send result.
 */
export async function sendVideoLark(params: {
  cfg: OpenClawConfig;
  to: string;
  fileKey: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  accountId?: string;
}): Promise<SendMediaResult> {
  const { cfg, to, fileKey, replyToMessageId, replyInThread, accountId } = params;
  log.info(`sendVideoLark: target=${to}, fileKey=${fileKey}`);

  const client = LarkClient.fromCfg(cfg, accountId).sdk;
  const content = JSON.stringify({ file_key: fileKey });
  return sendMediaMessage({ client, to, content, msgType: 'media', replyToMessageId, replyInThread });
}

// ---------------------------------------------------------------------------
// sendAudioLark
// ---------------------------------------------------------------------------

/**
 * Send an audio message to a chat or user.
 *
 * Uses `msg_type: "audio"` so Feishu renders the message as a playable
 * voice bubble instead of a file attachment.
 *
 * @param params.cfg              - Plugin configuration.
 * @param params.to               - Target identifier.
 * @param params.fileKey          - The file_key from a previous upload.
 * @param params.replyToMessageId - Optional message ID for threaded reply.
 * @param params.replyInThread    - When true, reply appears in thread.
 * @param params.accountId        - Optional account identifier.
 * @returns The send result.
 */
export async function sendAudioLark(params: {
  cfg: OpenClawConfig;
  to: string;
  fileKey: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  accountId?: string;
}): Promise<SendMediaResult> {
  const { cfg, to, fileKey, replyToMessageId, replyInThread, accountId } = params;
  log.info(`sendAudioLark: target=${to}, fileKey=${fileKey}`);

  const client = LarkClient.fromCfg(cfg, accountId).sdk;
  const content = JSON.stringify({ file_key: fileKey });
  return sendMediaMessage({ client, to, content, msgType: 'audio', replyToMessageId, replyInThread });
}

// ---------------------------------------------------------------------------
// detectFileType
// ---------------------------------------------------------------------------

/** Known image extensions. */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.ico', '.tiff', '.tif', '.heic']);

/** Extension-to-Feishu-file-type mapping. */
const EXTENSION_TYPE_MAP: Record<string, 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'> = {
  '.opus': 'opus',
  '.ogg': 'opus',
  '.mp4': 'mp4',
  '.mov': 'mp4',
  '.avi': 'mp4',
  '.mkv': 'mp4',
  '.webm': 'mp4',
  '.pdf': 'pdf',
  '.doc': 'doc',
  '.docx': 'doc',
  '.xls': 'xls',
  '.xlsx': 'xls',
  '.csv': 'xls',
  '.ppt': 'ppt',
  '.pptx': 'ppt',
};

/**
 * Detect the Feishu file type from a file name extension.
 *
 * Returns one of the Feishu-supported file type strings, or "stream"
 * as a catch-all for unrecognised extensions.
 *
 * @param fileName - The file name (with extension).
 * @returns The detected file type.
 */
export function detectFileType(fileName: string): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
  const ext = path.extname(fileName).toLowerCase();
  return EXTENSION_TYPE_MAP[ext] ?? 'stream';
}

/**
 * Parse the duration (in milliseconds) from an OGG/Opus audio buffer.
 *
 * Scans backward from the end of the buffer to find the last OggS page
 * header, reads the granule position (absolute sample count), and divides
 * by 48 000 (the Opus standard sample rate) then converts to milliseconds.
 *
 * Returns `undefined` when the buffer cannot be parsed (e.g. truncated or
 * not actually OGG).  This is intentionally lenient so callers can fall
 * back gracefully.
 */
export function parseOggOpusDuration(buffer: Buffer): number | undefined {
  // OggS magic bytes: 0x4f 0x67 0x67 0x53
  const OGGS = Buffer.from('OggS');

  // Scan backwards for the last OggS sync word.
  let offset = -1;
  for (let i = buffer.length - OGGS.length; i >= 0; i--) {
    if (buffer[i] === 0x4f && buffer.compare(OGGS, 0, 4, i, i + 4) === 0) {
      offset = i;
      break;
    }
  }

  if (offset < 0) return undefined;

  // Granule position is at bytes 6..13 of the page header (8 bytes, little-endian).
  const granuleOffset = offset + 6;
  if (granuleOffset + 8 > buffer.length) return undefined;

  // Read as two 32-bit LE values and combine (avoids BigInt for portability).
  const lo = buffer.readUInt32LE(granuleOffset);
  const hi = buffer.readUInt32LE(granuleOffset + 4);
  const granule = hi * 0x1_0000_0000 + lo;

  if (granule <= 0) return undefined;

  return Math.ceil(granule / 48_000) * 1000;
}

/**
 * Parse the duration (in milliseconds) from an MP4 video buffer.
 *
 * Scans top-level boxes to locate the `moov` container, then finds the
 * `mvhd` (Movie Header) box inside it.  The `mvhd` box stores:
 *   - **timescale**: number of time-units per second
 *   - **duration**: total duration in those time-units
 *
 * Supports both version-0 (32-bit fields) and version-1 (64-bit fields)
 * of the `mvhd` box.
 *
 * Returns `undefined` when the buffer cannot be parsed (e.g. truncated,
 * `moov` at end of a huge file not fully buffered, or not actually MP4).
 */
export function parseMp4Duration(buffer: Buffer): number | undefined {
  // Locate `moov` among top-level boxes.
  const moovData = findBox(buffer, 0, buffer.length, 'moov');
  if (!moovData) return undefined;

  // Locate `mvhd` inside `moov`.
  const mvhdData = findBox(buffer, moovData.dataStart, moovData.dataEnd, 'mvhd');
  if (!mvhdData) return undefined;

  const off = mvhdData.dataStart;
  if (off + 1 > buffer.length) return undefined;

  const version = buffer.readUInt8(off);

  let timescale: number;
  let duration: number;

  if (version === 0) {
    // version(1) + flags(3) + creation(4) + modification(4) + timescale(4) + duration(4) = 20 bytes
    if (off + 20 > buffer.length) return undefined;
    timescale = buffer.readUInt32BE(off + 12);
    duration = buffer.readUInt32BE(off + 16);
  } else {
    // version(1) + flags(3) + creation(8) + modification(8) + timescale(4) + duration(8) = 32 bytes
    if (off + 32 > buffer.length) return undefined;
    timescale = buffer.readUInt32BE(off + 20);
    // Read 64-bit duration as two 32-bit halves (avoids BigInt).
    const hi = buffer.readUInt32BE(off + 24);
    const lo = buffer.readUInt32BE(off + 28);
    duration = hi * 0x1_0000_0000 + lo;
  }

  if (timescale <= 0 || duration <= 0) return undefined;

  return Math.round((duration / timescale) * 1000);
}

/**
 * Find a box (atom) by its 4-character type within a range of the buffer.
 * Returns the data start/end offsets (after the 8-byte box header), or
 * `undefined` if not found.
 */
function findBox(
  buffer: Buffer,
  start: number,
  end: number,
  type: string,
): { dataStart: number; dataEnd: number } | undefined {
  let offset = start;
  while (offset + 8 <= end) {
    const size = buffer.readUInt32BE(offset);
    const boxType = buffer.toString('ascii', offset + 4, offset + 8);

    // size == 0 means box extends to the end; size == 1 means 64-bit extended size.
    let boxEnd: number;
    let dataStart: number;
    if (size === 0) {
      boxEnd = end;
      dataStart = offset + 8;
    } else if (size === 1) {
      if (offset + 16 > end) break;
      const hi = buffer.readUInt32BE(offset + 8);
      const lo = buffer.readUInt32BE(offset + 12);
      boxEnd = offset + hi * 0x1_0000_0000 + lo;
      dataStart = offset + 16;
    } else {
      if (size < 8) break; // invalid
      boxEnd = offset + size;
      dataStart = offset + 8;
    }

    if (boxType === type) {
      return { dataStart, dataEnd: Math.min(boxEnd, end) };
    }

    offset = boxEnd;
  }
  return undefined;
}

/**
 * Check whether a file name has an image extension.
 */
function isImageFileName(fileName: string): boolean {
  const ext = path.extname(fileName).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

// ---------------------------------------------------------------------------
// uploadAndSendMediaLark
// ---------------------------------------------------------------------------

/**
 * Upload and send a media file (image or general file) in one step.
 *
 * Accepts either a URL (remote or local `file://`) or a raw Buffer.
 * The function determines whether the media is an image (by extension)
 * and uses the appropriate upload/send path.
 *
 * @param params.cfg              - Plugin configuration.
 * @param params.to               - Target identifier.
 * @param params.mediaUrl         - URL of the media (http/https or local path).
 * @param params.mediaBuffer      - Raw bytes of the media (alternative to URL).
 * @param params.fileName         - File name (used for type detection and display).
 * @param params.replyToMessageId - Optional message ID for threaded reply.
 * @param params.accountId        - Optional account identifier.
 * @returns The send result.
 */
export async function uploadAndSendMediaLark(params: {
  cfg: OpenClawConfig;
  to: string;
  mediaUrl?: string;
  mediaBuffer?: Buffer;
  fileName?: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  accountId?: string;
  /** Allowed root directories for local file access (SSRF prevention). */
  mediaLocalRoots?: readonly string[];
}): Promise<SendMediaResult> {
  const { cfg, to, mediaUrl, mediaBuffer, fileName, replyToMessageId, replyInThread, accountId, mediaLocalRoots } =
    params;

  log.info(
    `uploadAndSendMediaLark: target=${to}, ` +
      `source=${mediaBuffer ? 'buffer' : (mediaUrl ?? '(none)')}, fileName=${fileName ?? '(auto)'}`,
  );

  // Resolve the media to a Buffer.
  let buffer: Buffer;
  let resolvedFileName = fileName ?? 'file';

  if (mediaBuffer) {
    buffer = mediaBuffer;
    log.debug(`using provided buffer: ${buffer.length} bytes`);
  } else if (mediaUrl) {
    buffer = await fetchMediaBuffer(mediaUrl, mediaLocalRoots);
    log.debug(`fetched media: ${buffer.length} bytes from "${mediaUrl}"`);

    // Derive a file name from the URL if none was provided.
    if (!fileName) {
      const derivedFileName = resolveFileNameFromMediaUrl(mediaUrl);
      if (derivedFileName) {
        resolvedFileName = derivedFileName;
      }
    }
  } else {
    throw new Error(
      '[feishu-media] uploadAndSendMediaLark requires either mediaUrl or mediaBuffer. ' +
        'Provide a URL (http/https/file://) or a raw Buffer to send media.',
    );
  }

  // Decide whether to send as image or file based on the extension.
  const isImage = isImageFileName(resolvedFileName);
  log.info(`resolved: fileName="${resolvedFileName}", ` + `type=${isImage ? 'image' : 'file'}, size=${buffer.length}`);

  if (isImage) {
    // Upload as image, then send image message.
    const { imageKey } = await uploadImageLark({
      cfg,
      image: buffer,
      imageType: 'message',
      accountId,
    });
    log.debug(`image uploaded: imageKey=${imageKey}`);

    return sendImageLark({
      cfg,
      to,
      imageKey,
      replyToMessageId,
      replyInThread,
      accountId,
    });
  }

  // Upload as file, then send as file or audio message.
  const fileType = detectFileType(resolvedFileName);
  const isAudio = fileType === 'opus';
  const isVideo = fileType === 'mp4';
  const duration = isAudio ? parseOggOpusDuration(buffer) : isVideo ? parseMp4Duration(buffer) : undefined;

  const { fileKey } = await uploadFileLark({
    cfg,
    file: buffer,
    fileName: resolvedFileName,
    fileType,
    duration,
    accountId,
  });
  log.debug(
    `file uploaded: fileKey=${fileKey}, ` +
      `fileType=${fileType}${isAudio || isVideo ? `, duration=${duration ?? 'unknown'}ms` : ''}`,
  );

  if (isAudio) {
    return sendAudioLark({ cfg, to, fileKey, replyToMessageId, replyInThread, accountId });
  }

  if (isVideo) {
    return sendVideoLark({ cfg, to, fileKey, replyToMessageId, replyInThread, accountId });
  }

  return sendFileLark({
    cfg,
    to,
    fileKey,
    replyToMessageId,
    replyInThread,
    accountId,
  });
}

// ---------------------------------------------------------------------------
// SSRF protection — private/reserved IP filtering
// ---------------------------------------------------------------------------

/**
 * Check whether an IP address belongs to a private or reserved range.
 *
 * Blocks: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
 * 169.254.0.0/16 (link-local / cloud metadata), 0.0.0.0,
 * IPv6 loopback (::1), link-local (fe80::), ULA (fc/fd).
 */
function isPrivateIP(ip: string): boolean {
  // IPv4 private / reserved ranges
  if (ip.startsWith('127.')) return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('169.254.')) return true;
  if (ip === '0.0.0.0') return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)) return true;

  // IPv6 private / reserved ranges
  if (ip === '::1' || ip === '::') return true;
  if (ip.startsWith('fe80:')) return true; // link-local
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // ULA
  return false;
}

/**
 * Validate that a remote URL does not target private/reserved IP addresses.
 *
 * Resolves the hostname via DNS and checks all returned addresses.
 * Rejects URLs with non-http(s) protocols.
 */
async function validateRemoteUrl(raw: string): Promise<void> {
  const parsed = new URL(raw);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `[feishu-media] Unsupported protocol "${parsed.protocol}" in URL "${raw}". ` +
        `Only http:// and https:// are allowed for remote media.`,
    );
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  if (net.isIP(hostname)) {
    // URL contains a literal IP address — check it directly.
    if (isPrivateIP(hostname)) {
      throw new Error(
        `[feishu-media] Access to private/reserved IP "${hostname}" is denied (SSRF protection). ` +
          `URL: "${raw}"`,
      );
    }
  } else {
    // Resolve the domain and check every address it points to.
    try {
      const addresses = await dns.resolve(hostname);
      for (const addr of addresses) {
        if (isPrivateIP(addr)) {
          throw new Error(
            `[feishu-media] Domain "${hostname}" resolves to private/reserved IP "${addr}" (SSRF protection). ` +
              `URL: "${raw}"`,
          );
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('SSRF protection')) {
        throw err;
      }
      // DNS failure is logged but not blocking — the subsequent fetch will
      // produce a clear network error if the host is truly unreachable.
      log.warn(`[feishu-media] DNS resolution failed for "${hostname}": ${err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// fetchMediaBuffer
// ---------------------------------------------------------------------------

/**
 * Fetch media bytes from a URL or local file path.
 *
 * Supports:
 * - `http://` and `https://` URLs (fetched via the global `fetch` API)
 * - `file://` URLs and bare file system paths (read from disk, gated
 *   by `localRoots` for path-traversal prevention)
 */
async function fetchMediaBuffer(urlOrPath: string, localRoots?: readonly string[]): Promise<Buffer> {
  const raw = normalizeMediaUrlInput(urlOrPath);

  // Local file path (absolute or relative, or file:// URL).
  if (isLocalMediaPath(raw)) {
    const filePath = raw.startsWith('file://') ? safeFileUrlToPath(raw) : raw;

    if (localRoots !== undefined) {
      // Explicit allowlist configured — enforce path restriction.
      validateLocalMediaRoots(filePath, localRoots);
    } else {
      // Deny by default: unconfigured mediaLocalRoots must not allow
      // arbitrary local file reads.
      throw new Error(
        `[feishu-media] Local file access denied for "${filePath}": ` +
          `mediaLocalRoots is not configured. ` +
          `Configure mediaLocalRoots to explicitly allow local file access.`,
      );
    }

    const buf = fs.readFileSync(filePath);
    log.debug(`local file read: "${filePath}", ${buf.length} bytes`);
    return buf;
  }

  // Remote URL — validate against SSRF before fetching.
  await validateRemoteUrl(raw);

  const FETCH_TIMEOUT_MS = 30_000;
  log.info(`fetching remote media: ${raw}`);
  const response = await fetch(raw, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(
      `[feishu-media] Failed to fetch media from "${raw}": ` +
        `HTTP ${response.status} ${response.statusText}. ` +
        `Verify the URL is accessible and returns a valid media resource.`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  log.debug(`remote media fetched: ${raw}, ${arrayBuffer.byteLength} bytes`);
  return Buffer.from(arrayBuffer);
}
