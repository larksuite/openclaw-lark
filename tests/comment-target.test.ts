import { describe, expect, it } from 'vitest';
import { buildFeishuCommentTarget, parseFeishuCommentTarget } from '../src/core/comment-target';

describe('comment target encoding', () => {
  it('keeps reply mode backward compatible', () => {
    const target = buildFeishuCommentTarget({
      fileType: 'docx',
      fileToken: 'abc123',
      commentId: '789',
    });

    expect(target).toBe('comment:docx:abc123:789');
    expect(parseFeishuCommentTarget(target)).toEqual({
      deliveryMode: 'reply',
      fileType: 'docx',
      fileToken: 'abc123',
      commentId: '789',
    });
  });

  it('encodes whole-comment delivery mode explicitly', () => {
    const target = buildFeishuCommentTarget({
      deliveryMode: 'create_whole',
      fileType: 'docx',
      fileToken: 'abc123',
      commentId: '789',
    });

    expect(target).toBe('comment:create_whole:docx:abc123:789');
    expect(parseFeishuCommentTarget(target)).toEqual({
      deliveryMode: 'create_whole',
      fileType: 'docx',
      fileToken: 'abc123',
      commentId: '789',
    });
  });
});
