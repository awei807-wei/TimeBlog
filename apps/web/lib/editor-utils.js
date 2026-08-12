/** @typedef {'draft'|'public'|'private'} EditorStatus */

/**
 * Convert the editor's friendly status to the persisted API contract.
 * The database status column never accepts `private`; privacy is visibility.
 * @param {EditorStatus} status
 */
export function serializeEditorStatus(status) {
  return {
    status: status === 'draft' ? 'draft' : 'published',
    visibility: status === 'private' ? 'private' : 'public',
  };
}

/**
 * @param {{status?: string; visibility?: string}} payload
 * @returns {EditorStatus}
 */
export function deserializeEditorStatus(payload) {
  if (payload.visibility === 'private' || payload.status === 'private') return 'private';
  return payload.status === 'published' ? 'public' : 'draft';
}

/** @param {string} markdown */
export function markdownToEditorHTML(markdown) {
  return markdown.split('\n').map(line => {
    const escaped = line.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    if (escaped.startsWith('### ')) return `<h3>${escaped.slice(4)}</h3>`;
    if (escaped.startsWith('## ')) return `<h2>${escaped.slice(3)}</h2>`;
    if (escaped.startsWith('# ')) return `<h1>${escaped.slice(2)}</h1>`;
    return `<p>${escaped || '<br/>'}</p>`;
  }).join('');
}

/**
 * Convert the deliberately small safe WYSIWYG subset to canonical Markdown.
 * In the browser, use DOM parsing so nested inline markup is flattened safely;
 * the regex fallback keeps this helper testable in Node.
 * @param {string} html
 */
export function editorHTMLToMarkdown(html) {
  if (typeof document !== 'undefined') {
    const root = document.createElement('div');
    root.innerHTML = html;
    return Array.from(root.children).map(node => {
      const text = node.textContent || '';
      if (node.tagName === 'H1') return `# ${text}`;
      if (node.tagName === 'H2') return `## ${text}`;
      if (node.tagName === 'H3') return `### ${text}`;
      return text;
    }).join('\n');
  }
  return html.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, text) => `\n# ${stripTags(text)}\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, text) => `\n## ${stripTags(text)}\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, text) => `\n### ${stripTags(text)}\n`)
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, text) => `\n${stripTags(text).replace(/^\s*$/, '')}\n`)
    .replace(/<br\s*\/?>/gi, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function stripTags(value) {
  return value.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** @param {string} markdown */
export function hasUnsupportedStructure(markdown) {
  return /(^|\n)(\s*[-*+] |\s*\d+\. |\s*```|\s*> )|\|.*\||\[[^\]]+\]\([^)]*\)|\[\^\w+\]|media:\/\//m.test(markdown);
}

/** @param {number} attempts @param {number} [now] */
export function nextRetryAt(attempts, now = Date.now()) {
  return now + Math.min(60_000, 1000 * (2 ** attempts));
}

/** @param {{untimed?: unknown[]; timed?: unknown[]}} day */
export function groupDayEntries(day) {
  return [...(day.untimed || []), ...(day.timed || [])];
}
