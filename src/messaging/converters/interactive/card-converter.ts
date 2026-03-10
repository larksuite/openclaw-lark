/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import type { Obj, RawCardContent, ConvertCardResult, TextStyle } from './types';
import { EMOJI_MAP, CHART_TYPE_NAMES } from './types';
import { escapeAttr, formatMillisecondsToISO8601, normalizeTimeFormat } from './card-utils';
import { safeParse } from '../utils';

type ElementConverterFn = (c: CardConverter, elem: Obj, prop: Obj, id: string, depth: number) => string;

export const MODE = { Concise: 0, Detailed: 1 } as const;
type Mode = (typeof MODE)[keyof typeof MODE];

const elementConverters = new Map<string, ElementConverterFn>([
  ['plain_text', (c, _elem, prop) => c.convertPlainText(prop)],
  ['markdown', (c, _elem, prop) => c.convertMarkdown(prop)],
  ['markdown_v1', (c, elem, prop) => c.convertMarkdownV1(elem, prop)],
  ['text', (c, _elem, prop) => c.convertPlainText(prop)],
  ['div', (c, _elem, prop, id) => c.convertDiv(prop, id)],
  ['note', (c, _elem, prop) => c.convertNote(prop)],
  ['hr', () => '---'],
  ['br', () => '\n'],
  ['column_set', (c, _elem, prop, _id, depth) => c.convertColumnSet(prop, depth)],
  ['column', (c, _elem, prop, _id, depth) => c.convertColumn(prop, depth)],
  ['person', (c, _elem, prop, id) => c.convertPerson(prop, id)],
  ['person_v1', (c, _elem, prop, id) => c.convertPersonV1(prop, id)],
  ['person_list', (c, _elem, prop) => c.convertPersonList(prop)],
  ['avatar', (c, _elem, prop, id) => c.convertAvatar(prop, id)],
  ['at', (c, _elem, prop) => c.convertAt(prop)],
  ['at_all', () => '@所有人'],
  ['button', (c, _elem, prop, id) => c.convertButton(prop, id)],
  ['actions', (c, _elem, prop) => c.convertActions(prop)],
  ['action', (c, _elem, prop) => c.convertActions(prop)],
  ['overflow', (c, _elem, prop) => c.convertOverflow(prop)],
  ['select_static', (c, _elem, prop, id) => c.convertSelect(prop, id, false)],
  ['multi_select_static', (c, _elem, prop, id) => c.convertSelect(prop, id, true)],
  ['select_person', (c, _elem, prop, id) => c.convertSelect(prop, id, false)],
  ['multi_select_person', (c, _elem, prop, id) => c.convertSelect(prop, id, true)],
  ['select_img', (c, _elem, prop, id) => c.convertSelectImg(prop, id)],
  ['input', (c, _elem, prop, id) => c.convertInput(prop, id)],
  ['date_picker', (c, _elem, prop, id) => c.convertDatePicker(prop, id, 'date')],
  ['picker_time', (c, _elem, prop, id) => c.convertDatePicker(prop, id, 'time')],
  ['picker_datetime', (c, _elem, prop, id) => c.convertDatePicker(prop, id, 'datetime')],
  ['checker', (c, _elem, prop, id) => c.convertChecker(prop, id)],
  ['img', (c, _elem, prop, id) => c.convertImage(prop, id)],
  ['image', (c, _elem, prop, id) => c.convertImage(prop, id)],
  ['img_combination', (c, _elem, prop) => c.convertImgCombination(prop)],
  ['table', (c, _elem, prop) => c.convertTable(prop)],
  ['chart', (c, _elem, prop, id) => c.convertChart(prop, id)],
  ['audio', (c, _elem, prop, id) => c.convertAudio(prop, id)],
  ['video', (c, _elem, prop, id) => c.convertVideo(prop, id)],
  ['collapsible_panel', (c, _elem, prop, id) => c.convertCollapsiblePanel(prop, id)],
  ['form', (c, _elem, prop, id) => c.convertForm(prop, id)],
  ['interactive_container', (c, _elem, prop, id) => c.convertInteractiveContainer(prop, id)],
  ['text_tag', (c, _elem, prop) => c.convertTextTag(prop)],
  ['number_tag', (c, _elem, prop) => c.convertNumberTag(prop)],
  ['link', (c, _elem, prop) => c.convertLink(prop)],
  ['emoji', (c, _elem, prop) => c.convertEmoji(prop)],
  ['local_datetime', (c, _elem, prop) => c.convertLocalDatetime(prop)],
  ['list', (c, _elem, prop) => c.convertList(prop)],
  ['blockquote', (c, _elem, prop) => c.convertBlockquote(prop)],
  ['code_block', (c, _elem, prop) => c.convertCodeBlock(prop)],
  ['code_span', (c, _elem, prop) => c.convertCodeSpan(prop)],
  ['heading', (c, _elem, prop) => c.convertHeading(prop)],
  ['fallback_text', (c, _elem, prop) => c.convertFallbackText(prop)],
  ['repeat', (c, _elem, prop) => c.convertRepeat(prop)],
  ['card_header', () => ''],
  ['custom_icon', () => ''],
  ['standard_icon', () => ''],
]);

export class CardConverter {
  private mode: Mode;
  private attachment: Obj | undefined;

  constructor(mode: Mode) {
    this.mode = mode;
  }

  convert(input: RawCardContent): ConvertCardResult {
    const card = safeParse(input.json_card) as Obj | undefined;
    if (!card) {
      return { content: '<card>\n[无法解析卡片内容]\n</card>', schema: 0 };
    }
    if (input.json_attachment) {
      this.attachment = safeParse(input.json_attachment) as Obj | undefined;
    }
    let schema = input.card_schema ?? 0;
    if (schema === 0) {
      const s = card.schema;
      schema = typeof s === 'number' ? s : 1;
    }
    const header = card.header as Obj | undefined;
    const title = header ? this.extractHeaderTitle(header, schema) : '';
    const body = this.extractBody(card, schema);
    const bodyContent = body ? this.convertBody(body, schema) : '';
    let out = title ? `<card title="${escapeAttr(title)}">\n` : '<card>\n';
    if (bodyContent) out += bodyContent + '\n';
    out += '</card>';
    return { content: out, schema };
  }

  private extractBody(card: Obj, _schema: number): Obj | undefined {
    if (card.body && typeof card.body === 'object') {
      return card.body as Obj;
    }
    return undefined;
  }

  private extractHeaderTitle(header: Obj, _schema: number): string {
    const prop = header.property as Obj | undefined;
    if (prop) {
      const titleElem = prop.title;
      if (titleElem) return this.extractTextContent(titleElem);
    } else {
      const titleElem = header.title;
      if (titleElem) return this.extractTextContent(titleElem);
    }
    return '';
  }

  private convertBody(body: Obj, _schema: number): string {
    let elements: unknown[] | undefined;

    const prop = body.property as Obj | undefined;
    if (prop) {
      const e = prop.elements;
      if (Array.isArray(e) && e.length > 0) elements = e;
    }

    if (!elements || elements.length === 0) {
      const e = body.elements;
      if (Array.isArray(e)) elements = e;
    }

    if (!elements || elements.length === 0) return '';
    return this.convertElements(elements, 0);
  }

  convertElements(elements: unknown[], depth: number): string {
    const results: string[] = [];
    for (const elem of elements) {
      if (typeof elem !== 'object' || elem === null) continue;
      const result = this.convertElement(elem as Obj, depth);
      if (result) results.push(result);
    }
    return results.join('\n');
  }

  convertElement(elem: Obj, depth: number): string {
    const tag = (elem.tag as string) ?? '';
    const id = (elem.id as string) ?? '';
    const prop = this.extractProperty(elem);

    const fn = elementConverters.get(tag);
    if (fn) return fn(this, elem, prop, id, depth);

    return this.convertUnknown(prop, tag);
  }

  extractProperty(elem: Obj): Obj {
    if (elem.property && typeof elem.property === 'object') {
      return elem.property as Obj;
    }
    return elem;
  }

  extractTextContent(textElem: unknown): string {
    if (textElem == null) return '';
    if (typeof textElem === 'string') return textElem;
    if (typeof textElem === 'object') {
      const m = textElem as Obj;
      if (m.property && typeof m.property === 'object') {
        return this.extractTextFromProperty(m.property as Obj);
      }
      return this.extractTextFromProperty(m);
    }
    return '';
  }

  private extractTextFromProperty(prop: Obj): string {
    const i18n = prop.i18nContent as Obj | undefined;
    if (i18n && typeof i18n === 'object') {
      for (const lang of ['zh_cn', 'en_us', 'ja_jp']) {
        const t = i18n[lang];
        if (typeof t === 'string' && t) return t;
      }
    }

    if (typeof prop.content === 'string') return prop.content;

    const elements = prop.elements;
    if (Array.isArray(elements) && elements.length > 0) {
      const texts: string[] = [];
      for (const elem of elements) {
        if (typeof elem === 'object' && elem !== null) {
          const t = this.extractTextContent(elem);
          if (t) texts.push(t);
        }
      }
      return texts.join('');
    }

    if (typeof prop.text === 'string') return prop.text;

    return '';
  }

  convertPlainText(prop: Obj): string {
    const content = prop.content as string | undefined;
    if (!content) return '';
    const style = this.extractTextStyle(prop);
    return this.applyTextStyle(content, style);
  }

  convertMarkdown(prop: Obj): string {
    const elements = prop.elements;
    if (Array.isArray(elements) && elements.length > 0) {
      return this.convertMarkdownElements(elements);
    }
    if (typeof prop.content === 'string') return prop.content;
    return '';
  }

  convertMarkdownV1(elem: Obj, prop: Obj): string {
    const elements = prop.elements;
    if (Array.isArray(elements) && elements.length > 0) {
      return this.convertMarkdownElements(elements);
    }
    const fallback = elem.fallback as Obj | undefined;
    if (fallback && typeof fallback === 'object') {
      return this.convertElement(fallback, 0);
    }
    if (typeof prop.content === 'string') return prop.content;
    return '';
  }

  convertMarkdownElements(elements: unknown[]): string {
    const parts: string[] = [];
    for (const elem of elements) {
      if (typeof elem !== 'object' || elem === null) continue;
      const result = this.convertElement(elem as Obj, 0);
      if (result) parts.push(result);
    }
    return parts.join('');
  }

  convertDiv(prop: Obj, _id: string): string {
    const results: string[] = [];

    const textElem = prop.text as Obj | undefined;
    if (textElem && typeof textElem === 'object') {
      const text = this.convertElement(textElem, 0);
      if (text) results.push(text);
    }

    const fields = prop.fields as unknown[] | undefined;
    if (Array.isArray(fields) && fields.length > 0) {
      const fieldTexts: string[] = [];
      for (const field of fields) {
        if (typeof field !== 'object' || field === null) continue;
        const fm = field as Obj;
        const te = fm.text as Obj | undefined;
        if (te && typeof te === 'object') {
          const ft = this.convertElement(te, 0);
          if (ft) fieldTexts.push(ft);
        }
      }
      if (fieldTexts.length > 0) results.push(fieldTexts.join('\n'));
    }

    const extraElem = prop.extra as Obj | undefined;
    if (extraElem && typeof extraElem === 'object') {
      const extra = this.convertElement(extraElem, 0);
      if (extra) results.push(extra);
    }

    return results.join('\n');
  }

  convertNote(prop: Obj): string {
    const elements = prop.elements as unknown[] | undefined;
    if (!Array.isArray(elements) || elements.length === 0) return '';

    const texts: string[] = [];
    for (const elem of elements) {
      if (typeof elem !== 'object' || elem === null) continue;
      const text = this.convertElement(elem as Obj, 0);
      if (text) texts.push(text);
    }

    if (texts.length === 0) return '';
    return `📝 ${texts.join(' ')}`;
  }

  convertLink(prop: Obj): string {
    const content = (prop.content as string) || '链接';
    let url = '';
    const urlObj = prop.url as Obj | undefined;
    if (urlObj && typeof urlObj === 'object') {
      url = (urlObj.url as string) || '';
    }
    if (url) return `[${content}](${url})`;
    return content;
  }

  convertEmoji(prop: Obj): string {
    const key = (prop.key as string) || '';
    return EMOJI_MAP[key] ?? `:${key}:`;
  }

  convertLocalDatetime(prop: Obj): string {
    const milliseconds = prop.milliseconds as string | undefined;
    const fallbackText = prop.fallbackText as string | undefined;

    if (milliseconds) {
      const formatted = formatMillisecondsToISO8601(milliseconds);
      if (formatted) return formatted;
    }
    return fallbackText || '';
  }

  convertList(prop: Obj): string {
    const items = prop.items as unknown[] | undefined;
    if (!Array.isArray(items) || items.length === 0) return '';

    const lines: string[] = [];
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue;
      const im = item as Obj;
      const level = (im.level as number) || 0;
      const listType = (im.type as string) || '';
      const order = (im.order as number) || 0;

      const indent = '  '.repeat(level);
      const marker = listType === 'ol' ? `${Math.floor(order)}.` : '-';

      const elements = im.elements as unknown[] | undefined;
      if (Array.isArray(elements)) {
        const content = this.convertMarkdownElements(elements);
        lines.push(`${indent}${marker} ${content}`);
      }
    }

    return lines.join('\n');
  }

  convertBlockquote(prop: Obj): string {
    let content = '';
    if (typeof prop.content === 'string') {
      content = prop.content;
    } else {
      const elements = prop.elements as unknown[] | undefined;
      if (Array.isArray(elements)) {
        content = this.convertMarkdownElements(elements);
      }
    }
    if (!content) return '';
    return content
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
  }

  convertCodeBlock(prop: Obj): string {
    const language = (prop.language as string) || 'plaintext';
    let code = '';
    const contents = prop.contents as unknown[] | undefined;
    if (Array.isArray(contents)) {
      for (const line of contents) {
        if (typeof line !== 'object' || line === null) continue;
        const lm = line as Obj;
        const lineContents = lm.contents as unknown[] | undefined;
        if (Array.isArray(lineContents)) {
          for (const c of lineContents) {
            if (typeof c !== 'object' || c === null) continue;
            const cm = c as Obj;
            if (typeof cm.content === 'string') code += cm.content;
          }
        }
      }
    }
    return `\`\`\`${language}\n${code}\`\`\``;
  }

  convertCodeSpan(prop: Obj): string {
    const content = (prop.content as string) || '';
    return `\`${content}\``;
  }

  convertHeading(prop: Obj): string {
    let level = (prop.level as number) || 1;
    if (level < 1) level = 1;
    if (level > 6) level = 6;

    let content = '';
    if (typeof prop.content === 'string') {
      content = prop.content;
    } else {
      const elements = prop.elements as unknown[] | undefined;
      if (Array.isArray(elements)) {
        content = this.convertMarkdownElements(elements);
      }
    }
    return `${'#'.repeat(level)} ${content}`;
  }

  convertFallbackText(prop: Obj): string {
    const textElem = prop.text as Obj | undefined;
    if (textElem && typeof textElem === 'object') {
      return this.extractTextContent(textElem);
    }
    const elements = prop.elements as unknown[] | undefined;
    if (Array.isArray(elements)) {
      return this.convertMarkdownElements(elements);
    }
    return '';
  }

  convertTextTag(prop: Obj): string {
    const textElem = prop.text as Obj | undefined;
    let text = '';
    if (textElem && typeof textElem === 'object') {
      text = this.extractTextContent(textElem);
    }
    if (!text) return '';
    return `「${text}」`;
  }

  convertNumberTag(prop: Obj): string {
    const textElem = prop.text as Obj | undefined;
    let text = '';
    if (textElem && typeof textElem === 'object') {
      text = this.extractTextContent(textElem);
    }
    if (!text) return '';

    const urlObj = prop.url as Obj | undefined;
    if (urlObj && typeof urlObj === 'object') {
      const url = urlObj.url as string | undefined;
      if (url) return `[${text}](${url})`;
    }
    return text;
  }

  convertUnknown(prop: Obj | undefined, tag: string): string {
    if (!prop) {
      if (this.mode === MODE.Detailed) return `[未知内容](tag:${tag})`;
      return '[未知内容]';
    }

    const paths = ['content', 'text', 'title', 'label', 'placeholder'] as const;
    for (const path of paths) {
      if (prop[path] != null) {
        const text = this.extractTextContent(prop[path]);
        if (text) return text;
      }
    }

    const elements = prop.elements as unknown[] | undefined;
    if (Array.isArray(elements) && elements.length > 0) {
      return this.convertElements(elements, 0);
    }

    if (this.mode === MODE.Detailed) return `[未知内容](tag:${tag})`;
    return '[未知内容]';
  }

  convertColumnSet(prop: Obj, depth: number): string {
    const columns = prop.columns as unknown[] | undefined;
    if (!Array.isArray(columns) || columns.length === 0) return '';

    const results: string[] = [];
    for (const col of columns) {
      if (typeof col !== 'object' || col === null) continue;
      const result = this.convertElement(col as Obj, depth + 1);
      if (result) results.push(result);
    }
    return results.join('\n\n');
  }

  convertColumn(prop: Obj, depth: number): string {
    const elements = prop.elements as unknown[] | undefined;
    if (!Array.isArray(elements) || elements.length === 0) return '';
    return this.convertElements(elements, depth);
  }

  convertForm(prop: Obj, _id: string): string {
    let out = '<form>\n';
    const elements = prop.elements as unknown[] | undefined;
    if (Array.isArray(elements)) {
      out += this.convertElements(elements, 0);
    }
    out += '\n</form>';
    return out;
  }

  convertCollapsiblePanel(prop: Obj, _id: string): string {
    const expanded = prop.expanded === true;

    let title = '详情';
    const header = prop.header as Obj | undefined;
    if (header && typeof header === 'object') {
      const titleElem = header.title;
      if (titleElem) {
        const t = this.extractTextContent(titleElem);
        if (t) title = t;
      }
    }

    const shouldExpand = expanded || this.mode === MODE.Detailed;

    if (shouldExpand) {
      let out = `▼ ${title}\n`;
      const elements = prop.elements as unknown[] | undefined;
      if (Array.isArray(elements)) {
        const content = this.convertElements(elements, 1);
        for (const line of content.split('\n')) {
          if (line) out += `    ${line}\n`;
        }
      }
      out += '▲';
      return out;
    }

    return `▶ ${title}`;
  }

  convertInteractiveContainer(prop: Obj, _id: string): string {
    let url = '';
    const actions = prop.actions as unknown[] | undefined;
    if (Array.isArray(actions) && actions.length > 0) {
      const action = actions[0] as Obj | undefined;
      if (action && typeof action === 'object') {
        const actionType = action.type as string | undefined;
        if (actionType === 'open_url') {
          const actionData = action.action as Obj | undefined;
          if (actionData && typeof actionData === 'object') {
            url = (actionData.url as string) || '';
          }
        }
      }
    }

    let out = '<clickable';
    if (url) out += ` url="${escapeAttr(url)}"`;
    if (this.mode === MODE.Detailed && _id) out += ` id="${_id}"`;
    out += '>\n';

    const elements = prop.elements as unknown[] | undefined;
    if (Array.isArray(elements)) {
      out += this.convertElements(elements, 0);
    }
    out += '\n</clickable>';
    return out;
  }

  convertRepeat(prop: Obj): string {
    const elements = prop.elements as unknown[] | undefined;
    if (Array.isArray(elements)) {
      return this.convertElements(elements, 0);
    }
    return '';
  }

  convertButton(prop: Obj, _id: string): string {
    let buttonText = '';
    const textElem = prop.text as Obj | undefined;
    if (textElem && typeof textElem === 'object') {
      buttonText = this.extractTextContent(textElem);
    }
    if (!buttonText) buttonText = '按钮';

    const disabled = prop.disabled === true;
    if (disabled && this.mode === MODE.Concise) {
      return `[${buttonText} ✗]`;
    }

    const actions = prop.actions as unknown[] | undefined;
    if (Array.isArray(actions)) {
      for (const action of actions) {
        if (typeof action !== 'object' || action === null) continue;
        const am = action as Obj;
        if (am.type === 'open_url') {
          const ad = am.action as Obj | undefined;
          if (ad && typeof ad === 'object') {
            const url = ad.url as string | undefined;
            if (url) return `[${buttonText}](${url})`;
          }
        }
      }
    }

    if (disabled && this.mode === MODE.Detailed) {
      let result = `[${buttonText} ✗]`;
      const tips = prop.disabledTips as Obj | undefined;
      if (tips && typeof tips === 'object') {
        const tipsText = this.extractTextContent(tips);
        if (tipsText) result += `(tips:"${tipsText}")`;
      }
      return result;
    }

    return `[${buttonText}]`;
  }

  convertActions(prop: Obj): string {
    const actions = prop.actions as unknown[] | undefined;
    if (!Array.isArray(actions) || actions.length === 0) return '';

    const results: string[] = [];
    for (const action of actions) {
      if (typeof action !== 'object' || action === null) continue;
      const result = this.convertElement(action as Obj, 0);
      if (result) results.push(result);
    }
    return results.join(' ');
  }

  convertSelect(prop: Obj, _id: string, isMulti: boolean): string {
    const options = (prop.options as unknown[]) || [];

    const selectedValues = new Set<string>();
    if (isMulti) {
      const vals = prop.selectedValues as unknown[] | undefined;
      if (Array.isArray(vals)) {
        for (const v of vals) {
          if (typeof v === 'string') selectedValues.add(v);
        }
      }
    } else {
      const initialOption = prop.initialOption as string | undefined;
      if (typeof initialOption === 'string') selectedValues.add(initialOption);
      const initialIndex = prop.initialIndex as number | undefined;
      if (typeof initialIndex === 'number' && initialIndex >= 0 && initialIndex < options.length) {
        const opt = options[initialIndex] as Obj | undefined;
        if (opt && typeof opt === 'object') {
          const val = opt.value as string | undefined;
          if (val) selectedValues.add(val);
        }
      }
    }

    const optionTexts: string[] = [];
    let hasSelected = false;
    for (const opt of options) {
      if (typeof opt !== 'object' || opt === null) continue;
      const om = opt as Obj;
      let optText = '';
      const textElem = om.text as Obj | undefined;
      if (textElem && typeof textElem === 'object') {
        optText = this.extractTextContent(textElem);
      }
      if (!optText) optText = (om.value as string) || '';
      if (!optText) continue;

      const value = (om.value as string) || '';
      if (selectedValues.has(value)) {
        optText = '✓' + optText;
        hasSelected = true;
      }
      optionTexts.push(optText);
    }

    if (optionTexts.length === 0) {
      let placeholder = '请选择';
      const phElem = prop.placeholder as Obj | undefined;
      if (phElem && typeof phElem === 'object') {
        const ph = this.extractTextContent(phElem);
        if (ph) placeholder = ph;
      }
      optionTexts.push(placeholder + ' ▼');
    } else if (!hasSelected) {
      optionTexts[optionTexts.length - 1] += ' ▼';
    }

    let result = `{${optionTexts.join(' / ')}}`;

    if (this.mode === MODE.Detailed) {
      const attrs: string[] = [];
      if (isMulti) attrs.push('multi');
      if (_id.includes('person') || prop.type === 'person') attrs.push('type:person');
      if (attrs.length > 0) result += `(${attrs.join(' ')})`;
    }

    return result;
  }

  convertSelectImg(prop: Obj, _id: string): string {
    const options = prop.options as unknown[] | undefined;
    if (!Array.isArray(options)) return '';

    const selectedValues = new Set<string>();
    const vals = prop.selectedValues as unknown[] | undefined;
    if (Array.isArray(vals)) {
      for (const v of vals) {
        if (typeof v === 'string') selectedValues.add(v);
      }
    }

    const optTexts: string[] = [];
    for (let i = 0; i < options.length; i++) {
      const opt = options[i] as Obj | undefined;
      if (!opt || typeof opt !== 'object') continue;
      const value = (opt.value as string) || '';
      let text = `🖼️图${i + 1}`;
      if (selectedValues.has(value)) text = '✓' + text;
      optTexts.push(text);
    }

    return `{${optTexts.join(' / ')}}`;
  }

  convertInput(prop: Obj, _id: string): string {
    let label = '';
    const labelElem = prop.label as Obj | undefined;
    if (labelElem && typeof labelElem === 'object') {
      label = this.extractTextContent(labelElem);
    }

    const defaultValue = (prop.defaultValue as string) || '';

    let placeholder = '';
    const phElem = prop.placeholder as Obj | undefined;
    if (phElem && typeof phElem === 'object') {
      placeholder = this.extractTextContent(phElem);
    }

    let result: string;
    if (defaultValue) {
      result = defaultValue + '___';
    } else if (placeholder) {
      result = placeholder + '_____';
    } else {
      result = '_____';
    }

    if (label) result = label + ': ' + result;

    const inputType = prop.inputType as string | undefined;
    if (inputType === 'multiline_text') {
      result = result.replace(/_____/g, '...');
    }

    return result;
  }

  convertDatePicker(prop: Obj, _id: string, pickerType: string): string {
    let emoji: string;
    let value = '';

    switch (pickerType) {
      case 'date':
        emoji = '📅';
        value = (prop.initialDate as string) || '';
        break;
      case 'time':
        emoji = '🕐';
        value = (prop.initialTime as string) || '';
        break;
      case 'datetime':
        emoji = '📅';
        value = (prop.initialDatetime as string) || '';
        break;
      default:
        emoji = '📅';
    }

    if (value) value = normalizeTimeFormat(value);

    if (!value) {
      let placeholder = '选择';
      const phElem = prop.placeholder as Obj | undefined;
      if (phElem && typeof phElem === 'object') {
        const ph = this.extractTextContent(phElem);
        if (ph) placeholder = ph;
      }
      value = placeholder;
    }

    return `${emoji} ${value}`;
  }

  convertChecker(prop: Obj, _id: string): string {
    const checked = prop.checked === true;
    const checkMark = checked ? '[x]' : '[ ]';

    let text = '';
    const textElem = prop.text as Obj | undefined;
    if (textElem && typeof textElem === 'object') {
      text = this.extractTextContent(textElem);
    }

    let result = `${checkMark} ${text}`;
    if (this.mode === MODE.Detailed && _id) {
      result += `(id:${_id})`;
    }
    return result;
  }

  convertOverflow(prop: Obj): string {
    const options = prop.options as unknown[] | undefined;
    if (!Array.isArray(options) || options.length === 0) return '';

    const optTexts: string[] = [];
    for (const opt of options) {
      if (typeof opt !== 'object' || opt === null) continue;
      const om = opt as Obj;
      const textElem = om.text as Obj | undefined;
      if (textElem && typeof textElem === 'object') {
        const text = this.extractTextContent(textElem);
        if (text) optTexts.push(text);
      }
    }

    return `⋮ ${optTexts.join(', ')}`;
  }

  convertPerson(prop: Obj, _id: string): string {
    const userID = (prop.userID as string) || '';
    if (!userID) return '';

    let personName = '';
    if (this.attachment) {
      const persons = this.attachment.persons as Obj | undefined;
      if (persons && typeof persons === 'object') {
        const person = persons[userID] as Obj | undefined;
        if (person && typeof person === 'object') {
          const content = person.content as string | undefined;
          if (content) personName = content;
        }
      }
    }

    if (!personName) {
      const notation = prop.notation as Obj | undefined;
      if (notation && typeof notation === 'object') {
        personName = this.extractTextContent(notation);
      }
    }

    if (personName) {
      if (this.mode === MODE.Detailed) return `@${personName}(open_id:${userID})`;
      return `@${personName}`;
    }

    if (this.mode === MODE.Detailed) return `@用户(open_id:${userID})`;
    return `@${userID}`;
  }

  convertPersonV1(prop: Obj, _id: string): string {
    const userID = (prop.userID as string) || '';
    if (!userID) return '';

    let personName = '';
    if (this.attachment) {
      const persons = this.attachment.persons as Obj | undefined;
      if (persons && typeof persons === 'object') {
        const person = persons[userID] as Obj | undefined;
        if (person && typeof person === 'object') {
          const content = person.content as string | undefined;
          if (content) personName = content;
        }
      }
    }

    if (personName) {
      if (this.mode === MODE.Detailed) return `@${personName}(open_id:${userID})`;
      return `@${personName}`;
    }

    if (this.mode === MODE.Detailed) return `@用户(open_id:${userID})`;
    return `@${userID}`;
  }

  convertPersonList(prop: Obj): string {
    const persons = prop.persons as unknown[] | undefined;
    if (!Array.isArray(persons) || persons.length === 0) return '';

    const names: string[] = [];
    for (const person of persons) {
      if (typeof person !== 'object' || person === null) continue;
      const pm = person as Obj;
      const personID = (pm.id as string) || '';
      const name = '用户';
      if (this.mode === MODE.Detailed && personID) {
        names.push(`@${name}(id:${personID})`);
      } else {
        names.push(`@${name}`);
      }
    }

    return names.join(', ');
  }

  convertAvatar(prop: Obj, _id: string): string {
    const userID = (prop.userID as string) || '';
    let result = '👤';
    if (this.mode === MODE.Detailed && userID) {
      result += `(id:${userID})`;
    }
    return result;
  }

  convertAt(prop: Obj): string {
    const userID = (prop.userID as string) || '';
    if (!userID) return '';

    let userName = '';
    let actualUserID = '';
    if (this.attachment) {
      const atUsers = this.attachment.at_users as Obj | undefined;
      if (atUsers && typeof atUsers === 'object') {
        const userInfo = atUsers[userID] as Obj | undefined;
        if (userInfo && typeof userInfo === 'object') {
          const content = userInfo.content as string | undefined;
          if (content) userName = content;
          const uid = userInfo.user_id as string | undefined;
          if (uid) actualUserID = uid;
        }
      }
    }

    if (userName) {
      if (this.mode === MODE.Detailed) {
        if (actualUserID) return `@${userName}(user_id:${actualUserID})`;
        return `@${userName}(open_id:${userID})`;
      }
      return `@${userName}`;
    }

    if (this.mode === MODE.Detailed) {
      if (actualUserID) return `@用户(user_id:${actualUserID})`;
      return `@用户(open_id:${userID})`;
    }
    return `@${userID}`;
  }

  convertImage(prop: Obj, _id: string): string {
    let alt = '图片';
    const altElem = prop.alt as Obj | undefined;
    if (altElem && typeof altElem === 'object') {
      const altText = this.extractTextContent(altElem);
      if (altText) alt = altText;
    }
    const titleElem = prop.title as Obj | undefined;
    if (titleElem && typeof titleElem === 'object') {
      const titleText = this.extractTextContent(titleElem);
      if (titleText) alt = titleText;
    }

    let result = `🖼️ ${alt}`;

    if (this.mode === MODE.Detailed) {
      const imageID = prop.imageID as string | undefined;
      if (imageID) {
        const token = this.getImageToken(imageID);
        if (token) {
          result += `(img_token:${token})`;
        } else {
          result += `(img_key:${imageID})`;
        }
      }
    }

    return result;
  }

  convertImgCombination(prop: Obj): string {
    const imgList = prop.imgList as unknown[] | undefined;
    if (!Array.isArray(imgList) || imgList.length === 0) return '';

    let result = `🖼️ ${imgList.length}张图片`;

    if (this.mode === MODE.Detailed) {
      const keys: string[] = [];
      for (const img of imgList) {
        if (typeof img !== 'object' || img === null) continue;
        const im = img as Obj;
        const imageID = im.imageID as string | undefined;
        if (imageID) keys.push(imageID);
      }
      if (keys.length > 0) result += `(keys:${keys.join(',')})`;
    }

    return result;
  }

  convertChart(prop: Obj, _id: string): string {
    let title = '图表';
    let chartType = '';
    const chartSpec = prop.chartSpec as Obj | undefined;
    if (chartSpec && typeof chartSpec === 'object') {
      const titleObj = chartSpec.title as Obj | undefined;
      if (titleObj && typeof titleObj === 'object') {
        const text = titleObj.text as string | undefined;
        if (text) title = text;
      }
      const ct = chartSpec.type as string | undefined;
      if (ct) {
        chartType = ct;
        const typeName = CHART_TYPE_NAMES[chartType];
        if (typeName) title = `${title}${typeName}`;
      }
    }

    const summary = this.extractChartSummary(prop, chartType);
    let result = `📊 ${title}`;
    if (summary) result += `\n数据摘要: ${summary}`;
    return result;
  }

  private extractChartSummary(prop: Obj, chartType: string): string {
    const chartSpec = prop.chartSpec as Obj | undefined;
    if (!chartSpec || typeof chartSpec !== 'object') return '';

    const dataObj = chartSpec.data as Obj | undefined;
    if (!dataObj || typeof dataObj !== 'object') return '';

    const values = dataObj.values as unknown[] | undefined;
    if (!Array.isArray(values) || values.length === 0) return '';

    switch (chartType) {
      case 'line':
      case 'bar':
      case 'area':
        return this.extractLineBarSummary(chartSpec, values);
      case 'pie':
        return this.extractPieSummary(chartSpec, values);
      default:
        return this.extractGenericSummary(values);
    }
  }

  private extractLineBarSummary(chartSpec: Obj, values: unknown[]): string {
    const xField = chartSpec.xField as string | undefined;
    const yField = chartSpec.yField as string | undefined;

    if (!xField || !yField || values.length === 0) {
      return this.extractGenericSummary(values);
    }

    const parts: string[] = [];
    for (const v of values) {
      if (typeof v !== 'object' || v === null) continue;
      const vm = v as Obj;
      parts.push(`${vm[xField]}:${vm[yField]}`);
    }
    return parts.length > 0 ? parts.join(', ') : this.extractGenericSummary(values);
  }

  private extractPieSummary(chartSpec: Obj, values: unknown[]): string {
    const categoryField = chartSpec.categoryField as string | undefined;
    const valueField = chartSpec.valueField as string | undefined;

    if (!categoryField || !valueField || values.length === 0) {
      return this.extractGenericSummary(values);
    }

    const parts: string[] = [];
    for (const v of values) {
      if (typeof v !== 'object' || v === null) continue;
      const vm = v as Obj;
      parts.push(`${vm[categoryField]}:${vm[valueField]}`);
    }
    return parts.length > 0 ? parts.join(', ') : this.extractGenericSummary(values);
  }

  private extractGenericSummary(values: unknown[]): string {
    return `${values.length}个数据点`;
  }

  convertAudio(prop: Obj, _id: string): string {
    let result = '🎵 音频';
    if (this.mode === MODE.Detailed) {
      const fileID = (prop.fileID as string) || (prop.audioID as string) || '';
      if (fileID) result += `(key:${fileID})`;
    }
    return result;
  }

  convertVideo(prop: Obj, _id: string): string {
    let result = '🎬 视频';
    if (this.mode === MODE.Detailed) {
      const fileID = (prop.fileID as string) || (prop.videoID as string) || '';
      if (fileID) result += `(key:${fileID})`;
    }
    return result;
  }

  convertTable(prop: Obj): string {
    const columns = prop.columns as unknown[] | undefined;
    if (!Array.isArray(columns) || columns.length === 0) return '';

    const rows = (prop.rows as unknown[]) || [];

    const colNames: string[] = [];
    const colKeys: string[] = [];
    for (const col of columns) {
      if (typeof col !== 'object' || col === null) continue;
      const cm = col as Obj;
      let displayName = (cm.displayName as string) || '';
      const name = (cm.name as string) || '';
      if (!displayName) displayName = name;
      colNames.push(displayName);
      colKeys.push(name);
    }

    const lines: string[] = [];
    lines.push('| ' + colNames.join(' | ') + ' |');
    lines.push('|' + colNames.map(() => '------|').join(''));

    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue;
      const rm = row as Obj;
      const cells: string[] = [];
      for (const key of colKeys) {
        let cellValue = '';
        const cellData = rm[key] as Obj | undefined;
        if (cellData && typeof cellData === 'object') {
          if (cellData.data != null) {
            cellValue = this.extractTableCellValue(cellData.data);
          }
        }
        cells.push(cellValue);
      }
      lines.push('| ' + cells.join(' | ') + ' |');
    }

    return lines.join('\n');
  }

  private extractTableCellValue(data: unknown): string {
    if (typeof data === 'string') return data;
    if (typeof data === 'number') return data.toFixed(2);
    if (Array.isArray(data)) {
      const texts: string[] = [];
      for (const item of data) {
        if (typeof item === 'object' && item !== null) {
          const im = item as Obj;
          if (typeof im.text === 'string') texts.push(`「${im.text}」`);
        }
      }
      return texts.join(' ');
    }
    if (typeof data === 'object' && data !== null) {
      return this.extractTextContent(data);
    }
    return '';
  }

  private extractTextStyle(prop: Obj): TextStyle {
    const style: TextStyle = {
      bold: false,
      italic: false,
      strikethrough: false,
    };

    const textStyle = prop.textStyle as Obj | undefined;
    if (!textStyle || typeof textStyle !== 'object') return style;

    const attrs = textStyle.attributes as unknown[] | undefined;
    if (Array.isArray(attrs)) {
      for (const attr of attrs) {
        if (typeof attr !== 'string') continue;
        switch (attr) {
          case 'bold':
            style.bold = true;
            break;
          case 'italic':
            style.italic = true;
            break;
          case 'strikethrough':
            style.strikethrough = true;
            break;
        }
      }
    }

    return style;
  }

  private applyTextStyle(content: string, style: TextStyle): string {
    if (!content) return content;
    if (style.strikethrough) content = `~~${content}~~`;
    if (style.italic) content = `*${content}*`;
    if (style.bold) content = `**${content}**`;
    return content;
  }

  private getImageToken(imageID: string): string {
    if (!this.attachment) return '';
    const images = this.attachment.images as Obj | undefined;
    if (!images || typeof images !== 'object') return '';
    const imageInfo = images[imageID] as Obj | undefined;
    if (!imageInfo || typeof imageInfo !== 'object') return '';
    return (imageInfo.token as string) || '';
  }
}
