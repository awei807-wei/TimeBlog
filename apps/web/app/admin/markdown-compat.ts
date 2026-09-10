/**
 * Lossless compatibility helpers around Novel's supported Markdown subset.
 * Unsupported source blocks become parser-safe tokens while editing and are
 * restored before IndexedDB, working-copy, or entry persistence.
 */

export type MarkdownCompatibilityReplacement = {
  source: string;
  token: string;
  start: number;
  end: number;
};

export type PreparedMarkdown = {
  markdown: string;
  replacements: MarkdownCompatibilityReplacement[];
};

type MarkdownLine = { text: string; start: number; end: number };
type ProtectedRange = { start: number; end: number };
type ScanResult = { end: number; range?: ProtectedRange };
type RawHtmlSpecial = { offset: number; terminator: string };

const TOKEN_PREFIX = '⟦timeblog-protected-';
const TOKEN_SUFFIX = '⟧';
const HTML_TAG_PATTERN = /<\/?[A-Za-z][^>]*>/g;
const HTML_AUTOLINK_PATTERN = /^<(?:(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)|(?:[A-Za-z0-9.!#$%&'*+\/?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*))>$/;
const RAW_HTML_BLOCK_PATTERN = /^\s{0,3}<(script|pre|style|textarea)(?=\s|>|$)/i;
const HTML_DECLARATION_PATTERN = /<![A-Z][^>]*>/;
const HTML_PROCESSING_INSTRUCTION_PATTERN = /<\?[\s\S]*?\?>/;
const HTML_CDATA_PATTERN = /<!\[CDATA\[[\s\S]*?\]\]>/;
const FOOTNOTE_PATTERN = /\[\^[^\]]+\]/;
const FOOTNOTE_DEFINITION_PATTERN = /^\s{0,3}\[\^[^\]]+\]:/;
const PROJECT_DIRECTIVE_PATTERN = /^(?:\s*:::+|\s*\{\{|\s*\{%)/m;
const COMMENT_PATTERN = /<!--[\s\S]*?-->/;
const FENCE_PATTERN = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const DIRECTIVE_OPEN_PATTERN = /^\s*:::+\S.*$/;
const DIRECTIVE_CLOSE_PATTERN = /^\s*:::+\s*$/;

function tokenFor(namespace: number, index: number) {
  return `${TOKEN_PREFIX}${namespace}-${index}${TOKEN_SUFFIX}`;
}

function isToken(value: string) {
  return /^⟦timeblog-protected-\d+-\d+⟧$/.test(value);
}

function withoutInlineCode(line: string) {
  let output = '';
  let cursor = 0;
  while (cursor < line.length) {
    if (line[cursor] !== '`') {
      output += line[cursor];
      cursor += 1;
      continue;
    }
    let markerEnd = cursor + 1;
    while (line[markerEnd] === '`') markerEnd += 1;
    const marker = line.slice(cursor, markerEnd);
    const closing = line.indexOf(marker, markerEnd);
    if (closing < 0) {
      output += line.slice(cursor);
      break;
    }
    output += line.slice(cursor, closing + marker.length).replace(/[^\n]/g, ' ');
    cursor = closing + marker.length;
  }
  return output;
}

function containsRawHtmlTag(source: string) {
  for (const match of source.matchAll(HTML_TAG_PATTERN)) {
    if (!HTML_AUTOLINK_PATTERN.test(match[0])) return true;
  }
  return false;
}

function protectBlock(source: string) {
  const candidate = withoutInlineCode(source);
  return Boolean(candidate.trim() && (
    FOOTNOTE_DEFINITION_PATTERN.test(candidate)
    || PROJECT_DIRECTIVE_PATTERN.test(candidate)
    || COMMENT_PATTERN.test(candidate)
    || containsRawHtmlTag(candidate)
    || HTML_DECLARATION_PATTERN.test(candidate)
    || HTML_PROCESSING_INSTRUCTION_PATTERN.test(candidate)
    || HTML_CDATA_PATTERN.test(candidate)
    || FOOTNOTE_PATTERN.test(candidate)
  ));
}

function splitLines(markdown: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let start = 0;
  while (start < markdown.length) {
    const newline = markdown.indexOf('\n', start);
    const end = newline < 0 ? markdown.length : newline;
    lines.push({ text: markdown.slice(start, end), start, end });
    if (newline < 0) break;
    start = newline + 1;
  }
  return lines;
}

function replacementNamespace(markdown: string) {
  let namespace = 0;
  while (markdown.includes(`${TOKEN_PREFIX}${namespace}-`)) namespace += 1;
  return namespace;
}

function findFenceEnd(lines: MarkdownLine[], start: number, marker: string) {
  for (let index = start + 1; index < lines.length; index += 1) {
    const closing = lines[index].text.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
    if (closing && closing[1][0] === marker[0] && closing[1].length >= marker.length) return index;
  }
  return lines.length - 1;
}

function maskInlineCodeByBlocks(lines: MarkdownLine[]) {
  const maskedLines: MarkdownLine[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].text.trim()) {
      maskedLines.push(lines[index]);
      index += 1;
      continue;
    }
    const fence = lines[index].text.match(FENCE_PATTERN);
    if (fence) {
      const end = findFenceEnd(lines, index, fence[1]);
      maskedLines.push(...lines.slice(index, end + 1));
      index = end + 1;
      continue;
    }
    let end = index;
    while (end + 1 < lines.length && lines[end + 1].text.trim() && !FENCE_PATTERN.test(lines[end + 1].text)) end += 1;
    const block = splitLines(withoutInlineCode(lines.slice(index, end + 1).map(line => line.text).join('\n')));
    for (let offset = 0; offset < block.length; offset += 1) {
      maskedLines.push({ ...lines[index + offset], text: block[offset].text });
    }
    index = end + 1;
  }
  return maskedLines;
}

function findCommentStart(lines: MarkdownLine[], maskedLines: MarkdownLine[], start: number) {
  for (let index = start; index < lines.length && lines[index].text.trim(); index += 1) {
    if (FENCE_PATTERN.test(lines[index].text)) break;
    if (maskedLines[index].text.includes('<!--')) return index;
  }
  return -1;
}

function findRawHtmlBlockTag(line: string) {
  return withoutInlineCode(line).match(RAW_HTML_BLOCK_PATTERN)?.[1].toLowerCase();
}

function findRawHtmlSpecial(line: string): RawHtmlSpecial | undefined {
  const candidate = withoutInlineCode(line);
  const starts = [
    { offset: candidate.indexOf('<![CDATA['), terminator: ']]>' },
    { offset: candidate.indexOf('<?'), terminator: '?>' },
    { offset: candidate.search(/<![A-Z]/), terminator: '>' },
  ].filter(({ offset }) => offset >= 0);
  return starts.sort((left, right) => left.offset - right.offset)[0];
}

function findRawHtmlSpecialEnd(lines: MarkdownLine[], start: number, special: RawHtmlSpecial) {
  if (lines[start].text.indexOf(special.terminator, special.offset) >= 0) return start;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].text.includes(special.terminator)) return index;
  }
  return lines.length - 1;
}

function findRawHtmlBlockEnd(lines: MarkdownLine[], start: number, tag: string) {
  const closing = new RegExp(`</${tag}\\s*>`, 'i');
  for (let index = start; index < lines.length; index += 1) {
    if (closing.test(lines[index].text)) return index;
  }
  return lines.length - 1;
}

function scanRawHtmlRange(lines: MarkdownLine[], maskedLines: MarkdownLine[], index: number): ScanResult | undefined {
  const rawHtmlBlockTag = findRawHtmlBlockTag(maskedLines[index].text);
  if (rawHtmlBlockTag) {
    const end = findRawHtmlBlockEnd(lines, index, rawHtmlBlockTag);
    return { end, range: { start: lines[index].start, end: lines[end].end } };
  }
  const rawHtmlSpecial = findRawHtmlSpecial(maskedLines[index].text);
  if (rawHtmlSpecial) {
    const end = findRawHtmlSpecialEnd(lines, index, rawHtmlSpecial);
    return { end, range: { start: lines[index].start, end: lines[end].end } };
  }
  return undefined;
}

function findCommentEnd(lines: MarkdownLine[], start: number) {
  let end = lines.length - 1;
  for (let index = start; index < lines.length; index += 1) {
    if (lines[index].text.includes('-->')) {
      end = index;
      break;
    }
  }
  while (end + 1 < lines.length && lines[end + 1].text.trim()) end += 1;
  return end;
}

function findDirectiveEnd(lines: MarkdownLine[], start: number) {
  for (let index = start + 1; index < lines.length; index += 1) {
    if (DIRECTIVE_CLOSE_PATTERN.test(lines[index].text)) return index;
  }
  return start;
}

function isFootnoteContinuation(line: string) {
  return /^(?: {4}|\t)/.test(line);
}

function findFootnoteEnd(lines: MarkdownLine[], start: number) {
  let end = start;
  let index = start + 1;
  while (index < lines.length) {
    if (isFootnoteContinuation(lines[index].text)) {
      end = index;
      index += 1;
      continue;
    }
    if (lines[index].text.trim()) break;
    let next = index;
    while (next < lines.length && !lines[next].text.trim()) next += 1;
    if (next >= lines.length || !isFootnoteContinuation(lines[next].text)) break;
    end = next;
    index = next + 1;
  }
  return end;
}

function alignedTableDelimiter(line: string) {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  const delimiter = cells.length > 0 && cells.every(cell => /^\s*:?-{3,}:?\s*$/.test(cell));
  return delimiter && /:\s*-{3,}|-{3,}\s*:/.test(line);
}

function findTableEnd(lines: MarkdownLine[], start: number) {
  let end = start + 1;
  while (end + 1 < lines.length && lines[end + 1].text.trim() && lines[end + 1].text.includes('|')) end += 1;
  return end;
}

function scanSpecialRange(lines: MarkdownLine[], maskedLines: MarkdownLine[], index: number): ScanResult | undefined {
  const fence = lines[index].text.match(FENCE_PATTERN);
  if (fence) {
    const end = findFenceEnd(lines, index, fence[1]);
    const range = /\s/.test(fence[2].trim()) ? { start: lines[index].start, end: lines[end].end } : undefined;
    return { end, range };
  }
  const rawHtml = scanRawHtmlRange(lines, maskedLines, index);
  if (rawHtml) return rawHtml;
  const commentStart = findCommentStart(lines, maskedLines, index);
  if (commentStart >= 0) {
    const end = findCommentEnd(lines, commentStart);
    return { end, range: { start: lines[index].start, end: lines[end].end } };
  }
  if (FOOTNOTE_DEFINITION_PATTERN.test(lines[index].text)) {
    const end = findFootnoteEnd(lines, index);
    return { end, range: { start: lines[index].start, end: lines[end].end } };
  }
  if (DIRECTIVE_OPEN_PATTERN.test(lines[index].text)) {
    const end = findDirectiveEnd(lines, index);
    return { end, range: { start: lines[index].start, end: lines[end].end } };
  }
  if (index + 1 < lines.length && alignedTableDelimiter(lines[index + 1].text)) {
    const end = findTableEnd(lines, index);
    return { end, range: { start: lines[index].start, end: lines[end].end } };
  }
  return undefined;
}

function collectProtectedRanges(markdown: string) {
  const lines = splitLines(markdown);
  const maskedLines = maskInlineCodeByBlocks(lines);
  const ranges: ProtectedRange[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].text.trim()) {
      index += 1;
      continue;
    }
    const special = scanSpecialRange(lines, maskedLines, index);
    if (special) {
      if (special.range) ranges.push(special.range);
      index = special.end + 1;
      continue;
    }
    let end = index;
    let nestedRawHtml: ScanResult | undefined;
    while (end + 1 < lines.length && lines[end + 1].text.trim() && !FENCE_PATTERN.test(lines[end + 1].text)) {
      nestedRawHtml = scanRawHtmlRange(lines, maskedLines, end + 1);
      if (nestedRawHtml) break;
      end += 1;
    }
    if (nestedRawHtml?.range) {
      ranges.push({ start: lines[index].start, end: nestedRawHtml.range.end });
      index = nestedRawHtml.end + 1;
      continue;
    }
    const source = markdown.slice(lines[index].start, lines[end].end);
    if (protectBlock(source)) ranges.push({ start: lines[index].start, end: lines[end].end });
    index = end + 1;
  }
  return ranges;
}

function applyProtectedRanges(markdown: string, ranges: ProtectedRange[], replacements: MarkdownCompatibilityReplacement[]) {
  const namespace = replacementNamespace(markdown);
  let cursor = 0;
  let output = '';
  for (const range of ranges) {
    const source = markdown.slice(range.start, range.end);
    const token = tokenFor(namespace, replacements.length);
    replacements.push({ source, token, start: range.start, end: range.end });
    output += `${markdown.slice(cursor, range.start)}${token}`;
    cursor = range.end;
  }
  return output + markdown.slice(cursor);
}

/** Prepare a Markdown document for the supported Novel/Tiptap schema. */
export function prepareMarkdownForNovel(markdown: string): PreparedMarkdown {
  const replacements: MarkdownCompatibilityReplacement[] = [];
  const normalized = String(markdown).replaceAll('\r\n', '\n');
  const prepared = applyProtectedRanges(normalized, collectProtectedRanges(normalized), replacements);
  return { markdown: prepared, replacements };
}

/** Restore each generated token once; user-authored lookalikes stay untouched. */
export function restoreMarkdownFromNovel(markdown: string, replacements: MarkdownCompatibilityReplacement[]) {
  return replacements.reduce((restored, replacement) => {
    const start = restored.indexOf(replacement.token);
    if (start < 0) return restored;
    return `${restored.slice(0, start)}${replacement.source}${restored.slice(start + replacement.token.length)}`;
  }, markdown);
}

/** Accept only TimeBlog's canonical persisted media URI grammar. */
export function isSafeMediaReference(value: string) {
  return /^media:\/\/[A-Za-z0-9._~-]+$/.test(value.trim());
}

export function isProtectedMarkdownToken(value: string) {
  return isToken(value);
}

// Compatibility aliases keep callers independent of the editor vendor name.
export const prepareMarkdownForEditor = prepareMarkdownForNovel;
export const restoreMarkdownFromEditor = restoreMarkdownFromNovel;
