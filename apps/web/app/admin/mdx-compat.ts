const VOID_HTML_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

// Keep ordinary HTML editable as HTML, but treat custom JSX/components as
// literal text. This avoids making the editor depend on application-specific
// component descriptors while preserving the original source for save.
const SAFE_HTML_TAGS = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'area', 'audio', 'b', 'base', 'bdi', 'bdo', 'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'cite', 'code', 'col', 'colgroup', 'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'embed', 'em', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'map', 'mark', 'menu', 'menuitem', 'meta', 'meter', 'nav', 'ol', 'optgroup', 'option', 'output', 'p', 'param', 'picture', 'pre', 'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'script', 'section', 'select', 'slot', 'small', 'source', 'span', 'strong', 'style', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr',
]);

export type Replacement = { source: string; editor: string; start: number; end: number };

export type PreparedMarkdown = {
  markdown: string;
  replacements: Replacement[];
};

type ParsedTag = {
  source: string;
  name: string;
  rawName: string;
  closing: boolean;
  selfClosing: boolean;
  validTail: boolean;
  end: number;
};

const FENCE_PATTERN = /^\s*(`{3,}|~{3,})/;
const NAME_CHAR = /[A-Za-z0-9:._-]/;

function htmlEntity(value: string) {
  return value.split('<').join('&lt;').split('>').join('&gt;');
}

function isPotentialTagTail(tail: string) {
  return !tail || /^\s/.test(tail) || /^\s*\/\s*$/.test(tail);
}

function readTagAt(line: string, start: number): ParsedTag | null {
  if (line[start] !== '<') return null;
  let cursor = start + 1;
  const closing = line[cursor] === '/';
  if (closing) cursor += 1;
  const nameStart = cursor;
  while (cursor < line.length && NAME_CHAR.test(line[cursor])) cursor += 1;
  if (cursor === nameStart) return null;
  const rawName = line.slice(nameStart, cursor);
  const tailStart = cursor;
  let quote = '';
  while (cursor < line.length) {
    const character = line[cursor];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      const tail = line.slice(tailStart, cursor);
      const trimmedTail = tail.trim();
      return {
        source: line.slice(start, cursor + 1),
        name: rawName.toLowerCase(),
        rawName,
        closing,
        selfClosing: !closing && /\/\s*$/.test(trimmedTail),
        validTail: isPotentialTagTail(tail),
        end: cursor + 1,
      };
    }
    cursor += 1;
  }
  return null;
}

function addReplacement(replacements: Replacement[], source: string, editor: string, start: number) {
  replacements.push({ source, editor, start, end: start + source.length });
}

/**
 * MDX treats an unmatched HTML-looking opening tag as JSX and refuses to
 * mount the whole document. Historical notes occasionally contain literal
 * strings such as `<Sub>`, custom components, or non-self-closing `<br>`.
 * Scan with quote-aware tag boundaries, skip code, and transform only the
 * unsafe tag tokens. The positional map lets the save path restore source
 * without a global string replacement.
 */
export function prepareMarkdownForMdxEditor(markdown: string): PreparedMarkdown {
  const replacements: Replacement[] = [];
  const malformed = new Set<number>();
  const stack: Array<{ name: string; start: number }> = [];
  const lines = markdown.split('\n');
  let offset = 0;
  let fenceMarker = '';
  let inlineCodeDelimiter = '';

  for (const line of lines) {
    const fence = line.match(FENCE_PATTERN);
    if (fence) {
      const marker = fence[1][0];
      const markerLength = fence[1].length;
      if (!fenceMarker) {
        fenceMarker = `${marker.repeat(markerLength)}`;
      } else if (fenceMarker[0] === marker && markerLength >= fenceMarker.length) {
        fenceMarker = '';
      }
      offset += line.length + 1;
      continue;
    }
    if (fenceMarker) {
      offset += line.length + 1;
      continue;
    }

    let cursor = 0;
    while (cursor < line.length) {
      if (inlineCodeDelimiter) {
        if (line.startsWith(inlineCodeDelimiter, cursor)) {
          cursor += inlineCodeDelimiter.length;
          inlineCodeDelimiter = '';
        } else {
          cursor += 1;
        }
        continue;
      }

      if (line[cursor] === '`') {
        let end = cursor + 1;
        while (line[end] === '`') end += 1;
        inlineCodeDelimiter = line.slice(cursor, end);
        cursor = end;
        continue;
      }

      if (line[cursor] !== '<') {
        cursor += 1;
        continue;
      }

      const tag = readTagAt(line, cursor);
      if (!tag) {
        cursor += 1;
        continue;
      }
      const start = offset + cursor;
      cursor = tag.end;

      const looksLikeJsxComponent = tag.rawName[0] !== tag.rawName[0].toLowerCase();
      if (!tag.validTail || looksLikeJsxComponent || !SAFE_HTML_TAGS.has(tag.name)) {
        malformed.add(start);
        continue;
      }
      if (tag.closing) {
        const stackIndex = [...stack].reverse().findIndex(item => item.name === tag.name);
        if (stackIndex < 0) malformed.add(start);
        else stack.splice(stack.length - 1 - stackIndex, 1);
        continue;
      }
      if (tag.selfClosing) continue;
      if (VOID_HTML_TAGS.has(tag.name)) {
        addReplacement(replacements, tag.source, `${tag.source.slice(0, -1).trimEnd()} />`, start);
        continue;
      }
      stack.push({ name: tag.name, start });
    }
    offset += line.length + 1;
  }

  for (const item of stack) malformed.add(item.start);

  const linesForMalformed = markdown.split('\n');
  let lineOffset = 0;
  for (const line of linesForMalformed) {
    let cursor = 0;
    while (cursor < line.length) {
      const tag = readTagAt(line, cursor);
      if (!tag) {
        cursor += 1;
        continue;
      }
      const start = lineOffset + cursor;
      if (malformed.has(start)) addReplacement(replacements, tag.source, htmlEntity(tag.source), start);
      cursor = tag.end;
    }
    lineOffset += line.length + 1;
  }

  if (replacements.length === 0) return { markdown, replacements };
  replacements.sort((a, b) => a.start - b.start);
  let prepared = '';
  let sourceCursor = 0;
  for (const replacement of replacements) {
    if (replacement.start < sourceCursor) continue;
    prepared += markdown.slice(sourceCursor, replacement.start);
    prepared += replacement.editor;
    sourceCursor = replacement.end;
  }
  prepared += markdown.slice(sourceCursor);
  return { markdown: prepared, replacements };
}

function replacementForms(replacement: Replacement) {
  const forms = [replacement.editor];
  const compactSelfClosing = replacement.editor.endsWith(' />') ? `${replacement.editor.slice(0, -3)}/>` : replacement.editor;
  if (compactSelfClosing !== replacement.editor) forms.push(compactSelfClosing);
  if (replacement.editor.startsWith('&lt;')) forms.push(`\\${replacement.source}`);
  return forms;
}

/** Restore mapped source tokens with a left-to-right scanner, never a global replace. */
export function restoreMarkdownFromMdxEditor(markdown: string, replacements: Replacement[]) {
  const forms = replacements.flatMap(replacement => replacementForms(replacement).map(form => ({ form, source: replacement.source })));
  forms.sort((a, b) => b.form.length - a.form.length);
  let restored = '';
  let cursor = 0;
  while (cursor < markdown.length) {
    const match = forms.find(item => markdown.startsWith(item.form, cursor));
    if (!match) {
      restored += markdown[cursor];
      cursor += 1;
      continue;
    }
    restored += match.source;
    cursor += match.form.length;
  }
  return restored;
}
