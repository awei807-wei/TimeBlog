const SUPPORTED_PROVIDERS = new Set(['youtube', 'bilibili', 'vimeo']);

function providerHostAllowed(provider, hostname) {
  if (provider === 'youtube') return hostname === 'youtube.com' || hostname.endsWith('.youtube.com') || hostname === 'youtu.be';
  if (provider === 'bilibili') return hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com');
  if (provider === 'vimeo') return hostname === 'vimeo.com' || hostname.endsWith('.vimeo.com');
  return false;
}

function finalPathSegment(parsed) {
  return parsed.pathname.split('/').filter(Boolean).pop() || '';
}

/**
 * Convert a whitelisted provider URL into a fixed iframe origin.
 * Returns an empty string for unsupported providers, schemes, hosts, or IDs.
 *
 * @param {string} provider
 * @param {string} rawURL
 * @returns {string}
 */
export function embedSource(provider, rawURL) {
  if (!SUPPORTED_PROVIDERS.has(provider) || typeof rawURL !== 'string' || rawURL.length > 2048) return '';
  let parsed;
  try {
    parsed = new URL(rawURL);
  } catch {
    return '';
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.port) return '';
  const hostname = parsed.hostname.toLowerCase();
  if (!providerHostAllowed(provider, hostname)) return '';
  if (provider === 'youtube') {
    const id = parsed.searchParams.get('v') || finalPathSegment(parsed);
    return id ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}` : '';
  }
  if (provider === 'vimeo') {
    const id = finalPathSegment(parsed);
    return id ? `https://player.vimeo.com/video/${encodeURIComponent(id)}` : '';
  }
  const id = parsed.searchParams.get('bvid') || finalPathSegment(parsed);
  return id ? `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(id)}&autoplay=0` : '';
}

export function isSupportedEmbedProvider(provider) {
  return SUPPORTED_PROVIDERS.has(provider);
}
