/**
 * Small, dependency-free GFM subset used for previews and fallback article
 * rendering. Every user-controlled value is escaped before markup is added.
 */
export function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function slugifyHeading(value) {
  const slug = value.toLowerCase().trim().replace(/[^\p{Letter}\p{Number}\s-]/gu, '').replace(/\s+/g, '-');
  return slug || 'section';
}

function safeUrl(value) {
  const decoded = value.replaceAll('&amp;', '&').trim();
  if (/^(https?:|mailto:|\/|#)/i.test(decoded)) return escapeHtml(decoded);
  return '#';
}

function mediaIdFromUrl(value) {
  const match = /^media:\/\/([A-Za-z0-9._~-]+)$/.exec(value.trim());
  return match?.[1] || '';
}

const highlightLanguages = new Set(['go', 'golang', 'js', 'javascript', 'ts', 'typescript', 'json', 'bash', 'sh', 'shell', 'sql', 'python', 'py', 'html', 'css']);
const highlightKeywords = {
  default: ['func', 'return', 'const', 'let', 'var', 'if', 'else', 'for', 'range', 'package', 'import', 'class', 'def', 'async', 'await', 'new', 'true', 'false', 'nil', 'null'],
  json: ['true', 'false', 'null'],
  sql: ['select', 'from', 'where', 'insert', 'update', 'delete', 'join', 'and', 'or', 'order', 'by', 'limit'],
};
const defaultKeywordLanguages = new Set(['go', 'golang', 'js', 'javascript', 'ts', 'typescript', 'python', 'py']);

/** Highlight the same safe token classes emitted by the backend renderer. */
function highlightCode(code, language) {
  const normalized = language.toLowerCase();
  if (!highlightLanguages.has(normalized) || normalized === 'mermaid') return code;
  const keywords = highlightKeywords[normalized] || (defaultKeywordLanguages.has(normalized) ? highlightKeywords.default : []);
  if (!keywords.length) return code.replace(/(&quot;[^&]*&quot;|&#39;[^&#39;]*&#39;)/g, '<span class="tok-string">$1</span>');
  const keywordPattern = keywords.map(keyword => keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const tokenPattern = new RegExp(`(&quot;[^&]*&quot;|&#39;[^&#39;]*&#39;)|\\b(${keywordPattern})\\b`, 'g');
  return code.replace(tokenPattern, (match, stringToken) => stringToken
    ? `<span class="tok-string">${match}</span>`
    : `<span class="tok-keyword">${match}</span>`);
}

export function renderInline(value) {
  let output = escapeHtml(value);
  const mediaPlaceholders = [];
  const holdMedia = html => { const index = mediaPlaceholders.push(html) - 1; return `\u0000MEDIA${index}\u0000`; };
  output = output.replace(/`([^`]+)`/g, '<code>$1</code>');
  output = output.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
    const label = alt || '未命名媒体';
    const mediaId = mediaIdFromUrl(url);
    if (mediaId) return holdMedia(`<span class="media-reference" data-media-id="${escapeHtml(mediaId)}" data-media-kind="image" data-media-label="${escapeHtml(label)}">媒体：${escapeHtml(label)}</span>`);
    return `<span class="media-reference" data-media-ref="${safeUrl(url)}">媒体：${escapeHtml(label)}</span>`;
  });
  output = output.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    const mediaId = mediaIdFromUrl(url);
    if (mediaId) return holdMedia(`<span class="media-reference" data-media-id="${escapeHtml(mediaId)}" data-media-kind="file" data-media-label="${escapeHtml(text)}">附件：${escapeHtml(text)}</span>`);
    return `<a href="${safeUrl(url)}" rel="noreferrer noopener">${text.replaceAll('media://', 'media&#58;//')}</a>`;
  });
  output = output.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  output = output.replace(/\*([^*]+)\*/g, '<em>$1</em>').replace(/_([^_]+)_/g, '<em>$1</em>');
  // Canonical Markdown references have already been converted to placeholders;
  // only bare tokens in the original source are expanded here.
  output = output.replace(/(^|[\s>])media:\/\/([A-Za-z0-9._~-]+)/g, '$1<span class="media-reference" data-media-id="$2" data-media-kind="unknown" data-media-label="媒体引用：$2">媒体引用：$2</span>');
  return output.replace(/\u0000MEDIA(\d+)\u0000/g, (_, index) => mediaPlaceholders[Number(index)] || '');
}

/** Decorate references emitted by the backend's minimal renderer. */
export function decorateMediaReferences(html) {
  return html.replace(/(^|[\s>])media:\/\/([A-Za-z0-9._~-]+)/g, (_, prefix, mediaId) => `${prefix}<span class="media-reference" data-media-id="${mediaId}" data-media-kind="unknown" data-media-label="媒体引用：${mediaId}">媒体引用：${mediaId}</span>`);
}

export function extractToc(markdown) {
  const seen = new Map();
  return markdown.split('\n').flatMap(line => {
    const match = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (!match) return [];
    const title = match[2].replace(/[*_`]/g, '');
    const base = slugifyHeading(title);
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return [{ level: match[1].length, title, id: count ? `${base}-${count + 1}` : base }];
  });
}

function renderTable(lines, index) {
  if (index + 1 >= lines.length || !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1])) return null;
  const cells = line => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(cell => cell.trim());
  const headers = cells(lines[index]);
  const rows = [];
  let cursor = index + 2;
  while (cursor < lines.length && lines[cursor].includes('|') && lines[cursor].trim()) { rows.push(cells(lines[cursor])); cursor += 1; }
  const head = headers.map(cell => `<th scope="col">${renderInline(cell)}</th>`).join('');
  const body = rows.map(row => `<tr>${headers.map((_, i) => `<td>${renderInline(row[i] || '')}</td>`).join('')}</tr>`).join('');
  return { html: `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`, next: cursor };
}

export function renderMarkdown(markdown) {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const toc = extractToc(markdown);
  const idByTitle = new Map(toc.map(item => [item.title, item.id]));
  const html = [];
  let paragraph = [];
  let inCode = false;
  let codeLanguage = '';
  let codeLines = [];
  const flushParagraph = () => { if (paragraph.length) { html.push(`<p>${renderInline(paragraph.join('\n')).replaceAll('\n', '<br/>')}</p>`); paragraph = []; } };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('```')) {
      if (inCode) { const language = escapeHtml(codeLanguage); const code = highlightCode(escapeHtml(codeLines.join('\n')), codeLanguage); const highlighted = highlightLanguages.has(codeLanguage.toLowerCase()) && codeLanguage.toLowerCase() !== 'mermaid' ? ' highlighted' : ''; html.push(`<pre><code class="language-${language}${highlighted}">${code}</code></pre>`); inCode = false; codeLanguage = ''; codeLines = []; }
      else { flushParagraph(); inCode = true; codeLanguage = line.slice(3).trim().replace(/[^A-Za-z0-9_-]/g, ''); }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) { flushParagraph(); const title = heading[2].trim(); const id = idByTitle.get(title) || slugifyHeading(title); html.push(`<h${heading[1].length} id="${escapeHtml(id)}">${renderInline(title)}</h${heading[1].length}>`); continue; }
    const table = renderTable(lines, i);
    if (table) { flushParagraph(); html.push(table.html); i = table.next - 1; continue; }
    if (/^\s*> ?/.test(line)) { flushParagraph(); html.push(`<blockquote>${renderInline(line.replace(/^\s*> ?/, ''))}</blockquote>`); continue; }
    if (/^\s*[-*+]\s+/.test(line)) { flushParagraph(); const items = []; while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push(`<li>${renderInline(lines[i].replace(/^\s*[-*+]\s+/, ''))}</li>`); i += 1; } html.push(`<ul>${items.join('')}</ul>`); i -= 1; continue; }
    if (/^\s*\d+\.\s+/.test(line)) { flushParagraph(); const items = []; while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(`<li>${renderInline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`); i += 1; } html.push(`<ol>${items.join('')}</ol>`); i -= 1; continue; }
    if (!line.trim()) flushParagraph(); else paragraph.push(line);
  }
  if (inCode) { const language = escapeHtml(codeLanguage); const code = highlightCode(escapeHtml(codeLines.join('\n')), codeLanguage); const highlighted = highlightLanguages.has(codeLanguage.toLowerCase()) && codeLanguage.toLowerCase() !== 'mermaid' ? ' highlighted' : ''; html.push(`<pre><code class="language-${language}${highlighted}">${code}</code></pre>`); }
  flushParagraph();
  return { html: html.join(''), toc };
}
