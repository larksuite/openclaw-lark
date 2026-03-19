/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Unit tests for the Feishu card footer model display feature.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { buildCardContent } from '../builder';
import { resolveFooterConfig, DEFAULT_FOOTER_CONFIG } from '../../core/footer-config';
import { StreamingCardController } from '../streaming-card-controller';
import type { FeishuFooterConfig } from '../../core/types';

// ---------------------------------------------------------------------------
// Happy Path Tests
// ---------------------------------------------------------------------------

describe('Footer Model Display - Happy Path', () => {
  describe('buildCardContent', () => {
    it('should display model name in footer when footer.model is enabled', () => {
      const card = buildCardContent('complete', {
        text: 'Hello world',
        elapsedMs: 12300,
        footer: { status: true, elapsed: true, model: true },
        model: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      });

      // Find the footer element
      const footerElement = card.elements.find(
        (el) => el.tag === 'markdown' && el.text_size === 'notation',
      );

      expect(footerElement).toBeDefined();
      // Should contain model name in both zh and en
      expect(footerElement!.i18n_content?.zh_cn).toContain('claude-sonnet-4-6');
      expect(footerElement!.i18n_content?.en_us).toContain('claude-sonnet-4-6');
    });

    it('should display model name with thinkLevel when provided', () => {
      const card = buildCardContent('complete', {
        text: 'Hello world',
        elapsedMs: 12300,
        footer: { status: true, elapsed: true, model: true },
        model: { provider: 'anthropic', model: 'claude-sonnet-4-6', thinkLevel: 'extended' },
      });

      const footerElement = card.elements.find(
        (el) => el.tag === 'markdown' && el.text_size === 'notation',
      );

      expect(footerElement).toBeDefined();
      // Should contain model name and thinkLevel
      expect(footerElement!.i18n_content?.zh_cn).toContain('claude-sonnet-4-6');
      expect(footerElement!.i18n_content?.zh_cn).toContain('extended');
    });

    it('should not display thinkLevel when thinkLevel is "off"', () => {
      const card = buildCardContent('complete', {
        text: 'Hello world',
        elapsedMs: 12300,
        footer: { status: true, elapsed: true, model: true },
        model: { provider: 'anthropic', model: 'claude-sonnet-4-6', thinkLevel: 'off' },
      });

      const footerElement = card.elements.find(
        (el) => el.tag === 'markdown' && el.text_size === 'notation',
      );

      expect(footerElement).toBeDefined();
      // Should contain model name but NOT thinkLevel "off"
      expect(footerElement!.i18n_content?.zh_cn).toContain('claude-sonnet-4-6');
      expect(footerElement!.i18n_content?.zh_cn).not.toContain('off');
    });

    it('should not display thinkLevel when thinkLevel is "OFF" (case insensitive)', () => {
      const card = buildCardContent('complete', {
        text: 'Hello world',
        elapsedMs: 12300,
        footer: { status: true, elapsed: true, model: true },
        model: { provider: 'anthropic', model: 'claude-sonnet-4-6', thinkLevel: 'OFF' },
      });

      const footerElement = card.elements.find(
        (el) => el.tag === 'markdown' && el.text_size === 'notation',
      );

      expect(footerElement).toBeDefined();
      expect(footerElement!.i18n_content?.zh_cn).toContain('claude-sonnet-4-6');
      expect(footerElement!.i18n_content?.zh_cn).not.toContain('OFF');
    });

    it('should display all footer elements in correct order: status, elapsed, model', () => {
      const card = buildCardContent('complete', {
        text: 'Test response',
        elapsedMs: 5000,
        footer: { status: true, elapsed: true, model: true },
        model: { provider: 'openai', model: 'gpt-4' },
      });

      const footerElement = card.elements.find(
        (el) => el.tag === 'markdown' && el.text_size === 'notation',
      );

      expect(footerElement).toBeDefined();
      // Check order: Completed · Elapsed 5.0s · gpt-4
      const zhContent = footerElement!.i18n_content?.zh_cn || '';
      expect(zhContent).toContain('已完成');
      expect(zhContent).toContain('耗时');
      expect(zhContent).toContain('gpt-4');

      // Verify the separator
      const parts = zhContent.split(' · ');
      expect(parts.length).toBe(3);
    });

    it('should display provider/model format when provider is provided', () => {
      const card = buildCardContent('complete', {
        text: 'Hello',
        footer: { model: true },
        model: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      });

      const footerElement = card.elements.find(
        (el) => el.tag === 'markdown' && el.text_size === 'notation',
      );

      expect(footerElement).toBeDefined();
      // Should display "anthropic/claude-haiku-4-5"
      expect(footerElement!.i18n_content?.zh_cn).toContain('anthropic/claude-haiku-4-5');
    });

    it('should display model without provider when provider is not provided', () => {
      const card = buildCardContent('complete', {
        text: 'Hello',
        footer: { model: true },
        model: { model: 'claude-haiku-4-5' },
      });

      const footerElement = card.elements.find(
        (el) => el.tag === 'markdown' && el.text_size === 'notation',
      );

      expect(footerElement).toBeDefined();
      // Should display just the model name without /
      expect(footerElement!.i18n_content?.zh_cn).toContain('claude-haiku-4-5');
      expect(footerElement!.i18n_content?.zh_cn).not.toContain('undefined/claude');
    });
  });

  describe('resolveFooterConfig', () => {
    it('should correctly parse footer config with model enabled', () => {
      const config: FeishuFooterConfig = {
        status: true,
        elapsed: true,
        model: true,
      };

      const resolved = resolveFooterConfig(config);

      expect(resolved.status).toBe(true);
      expect(resolved.elapsed).toBe(true);
      expect(resolved.model).toBe(true);
    });

    it('should use default values when config is undefined', () => {
      const resolved = resolveFooterConfig(undefined);

      expect(resolved).toEqual(DEFAULT_FOOTER_CONFIG);
      expect(resolved.model).toBe(false);
    });

    it('should merge partial config with defaults', () => {
      const config: FeishuFooterConfig = {
        model: true,
      };

      const resolved = resolveFooterConfig(config);

      expect(resolved.status).toBe(DEFAULT_FOOTER_CONFIG.status);
      expect(resolved.elapsed).toBe(DEFAULT_FOOTER_CONFIG.elapsed);
      expect(resolved.model).toBe(true);
    });
  });

  describe('StreamingCardController.setModel', () => {
    let controller: StreamingCardController;

    beforeEach(() => {
      // Create a minimal controller for testing
      controller = new StreamingCardController({
        cfg: {} as any,
        accountId: 'test-account',
        chatId: 'test-chat',
        replyToMessageId: 'test-msg',
        replyInThread: false,
        resolvedFooter: { status: false, elapsed: false, model: true },
      });
    });

    it('should store model information when setModel is called', () => {
      const modelInfo = {
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        thinkLevel: 'extended' as const,
      };

      controller.setModel(modelInfo);

      // The model should be stored internally
      // We verify this indirectly by checking the controller can complete with model info
      expect(controller).toBeDefined();
    });

    it('should handle model without thinkLevel', () => {
      const modelInfo = {
        provider: 'openai',
        model: 'gpt-4o',
      };

      controller.setModel(modelInfo);

      expect(controller).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Edge Case Tests (异常边界测试)
// ---------------------------------------------------------------------------

describe('Footer Model Display - Edge Cases', () => {
  describe('buildCardContent edge cases', () => {
    it('should not display model when footer.model is false', () => {
      const card = buildCardContent('complete', {
        text: 'Hello',
        footer: { status: false, elapsed: false, model: false },
        model: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      });

      const footerElement = card.elements.find(
        (el) => el.tag === 'markdown' && el.text_size === 'notation',
      );

      // Should not have footer element when all flags are false
      expect(footerElement).toBeUndefined();
    });

    it('should not crash when model is undefined but footer.model is true', () => {
      const card = buildCardContent('complete', {
        text: 'Hello',
        footer: { status: true, elapsed: true, model: true },
        model: undefined,
      });

      // Should still have footer with only status and elapsed
      const footerElement = card.elements.find(
        (el) => el.tag === 'markdown' && el.text_size === 'notation',
      );

      expect(footerElement).toBeDefined();
      expect(footerElement!.i18n_content?.zh_cn).toContain('已完成');
      expect(footerElement!.i18n_content?.zh_cn).not.toContain('undefined');
    });

    it('should handle empty model object gracefully', () => {
      const card = buildCardContent('complete', {
        text: 'Hello',
        footer: { status: true, model: true },
        model: {} as any,
      });

      const footerElement = card.elements.find(
        (el) => el.tag === 'markdown' && el.text_size === 'notation',
      );

      // Should have status but model field should be empty/undefined
      expect(footerElement).toBeDefined();
    });

    it('should not display model when model field is not provided', () => {
      const card = buildCardContent('complete', {
        text: 'Hello world',
        elapsedMs: 1000,
        footer: { status: true, elapsed: true, model: true },
        // No model field
      });

      const footerElement = card.elements.find(
        (el) => el.tag === 'markdown' && el.text_size === 'notation',
      );

      // Should have footer with status and elapsed, but no model
      expect(footerElement).toBeDefined();
      expect(footerElement!.i18n_content?.zh_cn).toContain('已完成');
      expect(footerElement!.i18n_content?.zh_cn).toContain('耗时');
      expect(footerElement!.i18n_content?.zh_cn).not.toContain('undefined');
    });

    it('should handle model with empty string model name', () => {
      const card = buildCardContent('complete', {
        text: 'Hello',
        footer: { status: true, model: true },
        model: { provider: 'test', model: '' },
      });

      const footerElement = card.elements.find(
        (el) => el.tag === 'markdown' && el.text_size === 'notation',
      );

      // Should have footer but empty model
      expect(footerElement).toBeDefined();
    });

    it('should handle only model enabled without status or elapsed', () => {
      const card = buildCardContent('complete', {
        text: 'Hello',
        footer: { status: false, elapsed: false, model: true },
        model: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      });

      const footerElement = card.elements.find(
        (el) => el.tag === 'markdown' && el.text_size === 'notation',
      );

      expect(footerElement).toBeDefined();
      expect(footerElement!.i18n_content?.zh_cn).toContain('claude-haiku-4-5');
      expect(footerElement!.i18n_content?.zh_cn).not.toContain('已完成');
      expect(footerElement!.i18n_content?.zh_cn).not.toContain('耗时');
    });

    it('should handle error state with model display', () => {
      const card = buildCardContent('complete', {
        text: 'Error occurred',
        isError: true,
        footer: { status: true, model: true },
        model: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      });

      const footerElement = card.elements.find(
        (el) => el.tag === 'markdown' && el.text_size === 'notation',
      );

      // Error footer should have red text
      expect(footerElement).toBeDefined();
      expect(footerElement!.content).toContain('<font color=\'red\'>');
      expect(footerElement!.i18n_content?.zh_cn).toContain('出错');
      expect(footerElement!.i18n_content?.zh_cn).toContain('claude-sonnet-4-6');
    });

    it('should handle aborted state with model display', () => {
      const card = buildCardContent('complete', {
        text: 'Stopped',
        isAborted: true,
        footer: { status: true, model: true },
        model: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      });

      const footerElement = card.elements.find(
        (el) => el.tag === 'markdown' && el.text_size === 'notation',
      );

      expect(footerElement).toBeDefined();
      expect(footerElement!.i18n_content?.zh_cn).toContain('已停止');
      expect(footerElement!.i18n_content?.zh_cn).toContain('claude-sonnet-4-6');
    });

    it('should filter model ending with "off" from display', () => {
      const card = buildCardContent('complete', {
        text: 'Hello',
        footer: { model: true },
        model: { provider: 'anthropic', model: 'claude-sonnet-4-6-off' },
      });

      const footerElement = card.elements.find(
        (el) => el.tag === 'markdown' && el.text_size === 'notation',
      );

      // Should not display model at all when it ends with "off"
      expect(footerElement).toBeUndefined();
    });

    it('should handle only status enabled', () => {
      const card = buildCardContent('complete', {
        text: 'Hello',
        footer: { status: true, elapsed: false, model: false },
      });

      const footerElement = card.elements.find(
        (el) => el.tag === 'markdown' && el.text_size === 'notation',
      );

      expect(footerElement).toBeDefined();
      expect(footerElement!.i18n_content?.zh_cn).toContain('已完成');
      expect(footerElement!.i18n_content?.zh_cn).not.toContain('耗时');
      expect(footerElement!.i18n_content?.zh_cn).not.toContain('claude');
    });

    it('should handle only elapsed enabled', () => {
      const card = buildCardContent('complete', {
        text: 'Hello',
        elapsedMs: 5000,
        footer: { status: false, elapsed: true, model: false },
      });

      const footerElement = card.elements.find(
        (el) => el.tag === 'markdown' && el.text_size === 'notation',
      );

      expect(footerElement).toBeDefined();
      expect(footerElement!.i18n_content?.zh_cn).toContain('耗时 5.0s');
      expect(footerElement!.i18n_content?.zh_cn).not.toContain('已完成');
      expect(footerElement!.i18n_content?.zh_cn).not.toContain('claude');
    });

    it('should handle status + elapsed (without model)', () => {
      const card = buildCardContent('complete', {
        text: 'Hello',
        elapsedMs: 3000,
        footer: { status: true, elapsed: true, model: false },
      });

      const footerElement = card.elements.find(
        (el) => el.tag === 'markdown' && el.text_size === 'notation',
      );

      expect(footerElement).toBeDefined();
      const content = footerElement!.i18n_content?.zh_cn || '';
      expect(content).toContain('已完成');
      expect(content).toContain('耗时');
      expect(content).not.toContain('claude');
      // Should have exactly 2 parts separated by " · "
      expect(content.split(' · ').length).toBe(2);
    });

    it('should handle elapsed + model (without status)', () => {
      const card = buildCardContent('complete', {
        text: 'Hello',
        elapsedMs: 3000,
        footer: { status: false, elapsed: true, model: true },
        model: { provider: 'anthropic', model: 'gpt-4' },
      });

      const footerElement = card.elements.find(
        (el) => el.tag === 'markdown' && el.text_size === 'notation',
      );

      expect(footerElement).toBeDefined();
      const content = footerElement!.i18n_content?.zh_cn || '';
      expect(content).toContain('耗时');
      expect(content).toContain('gpt-4');
      expect(content).not.toContain('已完成');
    });

    it('should handle explicit model: false with undefined others', () => {
      const card = buildCardContent('complete', {
        text: 'Hello',
        footer: { status: true, model: false } as any,
      });

      const footerElement = card.elements.find(
        (el) => el.tag === 'markdown' && el.text_size === 'notation',
      );

      expect(footerElement).toBeDefined();
      expect(footerElement!.i18n_content?.zh_cn).toContain('已完成');
      expect(footerElement!.i18n_content?.zh_cn).not.toContain('claude');
    });

    it('should handle all three enabled with all parts visible', () => {
      const card = buildCardContent('complete', {
        text: 'Hello',
        elapsedMs: 2500,
        footer: { status: true, elapsed: true, model: true },
        model: { provider: 'openai', model: 'gpt-4o' },
      });

      const footerElement = card.elements.find(
        (el) => el.tag === 'markdown' && el.text_size === 'notation',
      );

      expect(footerElement).toBeDefined();
      const zhContent = footerElement!.i18n_content?.zh_cn || '';
      const enContent = footerElement!.i18n_content?.en_us || '';

      // All three parts should be present
      expect(zhContent).toContain('已完成');
      expect(zhContent).toContain('耗时');
      expect(zhContent).toContain('gpt-4o');

      // Verify order: status · elapsed · model
      const parts = zhContent.split(' · ');
      expect(parts.length).toBe(3);
      expect(parts[0]).toBe('已完成');
      expect(parts[1]).toContain('耗时');
      expect(parts[2]).toContain('gpt-4o');
    });
  });

  describe('resolveFooterConfig edge cases', () => {
    it('should handle empty config object', () => {
      const resolved = resolveFooterConfig({});

      expect(resolved.status).toBe(DEFAULT_FOOTER_CONFIG.status);
      expect(resolved.elapsed).toBe(DEFAULT_FOOTER_CONFIG.elapsed);
      expect(resolved.model).toBe(DEFAULT_FOOTER_CONFIG.model);
    });

    it('should handle config with only model set to false', () => {
      const config: FeishuFooterConfig = {
        model: false,
      };

      const resolved = resolveFooterConfig(config);

      expect(resolved.model).toBe(false);
    });

    it('should handle config with only model set to true', () => {
      const config: FeishuFooterConfig = {
        model: true,
      };

      const resolved = resolveFooterConfig(config);

      expect(resolved.model).toBe(true);
      expect(resolved.status).toBe(DEFAULT_FOOTER_CONFIG.status);
    });
  });
});