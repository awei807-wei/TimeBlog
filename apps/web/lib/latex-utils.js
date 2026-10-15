/**
 * Decode both standard base64 and unpadded base64url LaTeX payloads.
 *
 * @param {string} value
 * @returns {string}
 */
export function decodeLatexBase64(value) {
  if (typeof value !== 'string') throw new TypeError('invalid LaTeX payload');
  let normalized = value.trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) throw new Error('invalid LaTeX base64');
  const paddingAt = normalized.indexOf('=');
  if (paddingAt >= 0 && normalized.slice(paddingAt).length > 2) throw new Error('invalid LaTeX base64 padding');
  normalized = normalized.replace(/=+$/, '');
  if (normalized.length % 4 === 1) throw new Error('invalid LaTeX base64 length');
  normalized += '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Encode raw LaTeX formula into unpadded base64url string.
 *
 * @param {string} value
 * @returns {string}
 */
export function encodeLatexBase64(value) {
  if (typeof value !== 'string') throw new TypeError('invalid LaTeX source');
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}