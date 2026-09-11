export type URLValidationResult =
  | { ok: true; value: string }
  | { ok: false; message: string };

const MAX_URL_LENGTH = 4096;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function invalid(message: string): URLValidationResult {
  return { ok: false, message };
}

/** Validate an external image without fetching it or weakening editor URI rules. */
export function validateExternalImageURL(input: string): URLValidationResult {
  const candidate = input.trim();
  if (!candidate) return invalid('请输入完整的图片地址。');
  if (candidate.length > MAX_URL_LENGTH) return invalid('图片地址过长，请换用更短的公开链接。');
  if (CONTROL_CHARACTER.test(candidate)) return invalid('图片地址包含不可用字符。');

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return invalid('图片地址格式不正确，请填写完整的 https:// 地址。');
  }

  if (parsed.protocol !== 'https:') {
    return invalid('公开页面只允许加载 https:// 图片地址。');
  }
  if (!parsed.hostname) return invalid('图片地址缺少有效域名。');
  if (parsed.username || parsed.password) return invalid('图片地址不能包含账号或密码。');

  return { ok: true, value: parsed.toString() };
}

/** Links support public web URLs plus local anchors and same-site paths. */
export function validateEditorLinkURL(input: string): URLValidationResult {
  const candidate = input.trim();
  if (!candidate) return invalid('请输入链接地址。');
  if (candidate.length > MAX_URL_LENGTH) return invalid('链接地址过长。');
  if (CONTROL_CHARACTER.test(candidate)) return invalid('链接地址包含不可用字符。');
  if (candidate.startsWith('#')) return { ok: true, value: candidate };
  if (candidate.startsWith('/') && !candidate.startsWith('//')) return { ok: true, value: candidate };

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return invalid('链接格式不正确，请填写完整地址或站内路径。');
  }

  if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol)) {
    return invalid('只支持 http、https、mailto、站内路径或页内锚点。');
  }
  if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && (!parsed.hostname || parsed.username || parsed.password)) {
    return invalid(parsed.username || parsed.password ? '链接不能包含账号或密码。' : '链接缺少有效域名。');
  }

  return { ok: true, value: parsed.toString() };
}
