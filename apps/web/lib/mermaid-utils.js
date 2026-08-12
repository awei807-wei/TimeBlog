/**
 * Decode both standard base64 and unpadded base64url Mermaid payloads.
 * The backend currently emits raw base64url, while older persisted content
 * may contain padded standard base64.
 *
 * @param {string} value
 * @returns {string}
 */
export function decodeMermaidBase64(value) {
  if (typeof value !== 'string') throw new TypeError('invalid Mermaid payload');
  let normalized = value.trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) throw new Error('invalid Mermaid base64');
  const paddingAt = normalized.indexOf('=');
  if (paddingAt >= 0 && normalized.slice(paddingAt).length > 2) throw new Error('invalid Mermaid base64 padding');
  normalized = normalized.replace(/=+$/, '');
  if (normalized.length % 4 === 1) throw new Error('invalid Mermaid base64 length');
  normalized += '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
