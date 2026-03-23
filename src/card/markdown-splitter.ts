import type { CardElement } from './builder';

function normalizeBlockContent(content: string): string {
  let s = String(content ?? '');
  s = s.replace(/^\n+/, '').replace(/\n+$/, '');
  s = s.replace(/[ \t]+$/gm, '');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function isBoldTitleLine(line: string): boolean {
  return /^\s*\*\*[^*]+\*\*\s*$/.test(line);
}

function isListLikeLine(line: string): boolean {
  return /^\s*(?:[-*+]\s+|\d+\.\s+|\d+\)\s+|\d+、\s+|[•·]\s+)/.test(line);
}

function isTableLine(trimmed: string): boolean {
  return trimmed.startsWith('|') && trimmed.endsWith('|');
}

function isFenceLine(trimmed: string): boolean {
  return trimmed.startsWith('```');
}

function createMarkdownElement(content: string): CardElement {
  return {
    tag: 'markdown',
    content: normalizeBlockContent(content),
  };
}

export function splitMarkdownToElements(markdown: string): CardElement[] {
  const text = String(markdown ?? '');
  const lines = text.split('\n');

  const elements: CardElement[] = [];
  let current: string[] = [];

  let inCodeBlock = false;
  let inTable = false;
  let inList = false;

  const flush = () => {
    if (current.length === 0) return;
    const normalized = normalizeBlockContent(current.join('\n'));
    if (normalized) elements.push(createMarkdownElement(normalized));
    current = [];
    inList = false;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^-{3,}$/.test(trimmed)) {
      flush();
      continue;
    }

    if (!inCodeBlock && isFenceLine(trimmed)) {
      flush();
      inCodeBlock = true;
      current.push(line);
      continue;
    }

    if (inCodeBlock) {
      current.push(line);
      if (isFenceLine(trimmed)) {
        inCodeBlock = false;
        flush();
      }
      continue;
    }

    const table = isTableLine(trimmed);
    if (table && !inTable) {
      flush();
      inTable = true;
      current.push(line);
      continue;
    }

    if (inTable) {
      if (table) {
        current.push(line);
        continue;
      }
      flush();
      inTable = false;
    }

    if (!trimmed) {
      flush();
      continue;
    }

    const list = isListLikeLine(line);
    if (list) {
      if (!inList) {
        if (current.length === 1 && isBoldTitleLine(current[0])) {
          inList = true;
          current.push(line);
          continue;
        }
        flush();
        inList = true;
      }
      current.push(line);
      continue;
    }

    if (inList) {
      flush();
    }

    current.push(line);
  }

  flush();
  return elements;
}
