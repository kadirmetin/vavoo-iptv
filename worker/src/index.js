import geil from '../../lib/geil.cjs';

const { ORIGIN, resolveChannel } = geil;
const LANGUAGE = 'tr';

const ALLOWED_EXTENSIONS = new Set([
  '.m3u8', '.ts', '.aac', '.mp3', '.m4s', '.mp4', '.m4a', '.key', '.vtt', '.webvtt'
]);

function pathExtension(urlString) {
  try {
    const p = new URL(urlString).pathname.toLowerCase();
    const dot = p.lastIndexOf('.');
    return dot === -1 ? '' : p.slice(dot);
  } catch {
    return '';
  }
}

function getStreamHeaders() {
  return {
    'User-Agent': 'VAVOO/2.6',
    'Accept': '*/*',
    'Accept-Language': LANGUAGE,
    'Origin': ORIGIN,
    'Referer': `${ORIGIN}/`,
    'Connection': 'close'
  };
}

function getPlaylistHeaders() {
  return {
    'User-Agent': 'libmpv',
    'Accept': 'application/vnd.apple.mpegurl, application/x-mpegURL, */*',
    'Accept-Language': LANGUAGE,
    'Origin': ORIGIN,
    'Referer': `${ORIGIN}/`,
    'Connection': 'close'
  };
}

function isM3u8Url(url) {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.m3u8');
  } catch {
    return false;
  }
}

function isM3u8Response(url, contentType) {
  const ct = String(contentType || '').toLowerCase();
  return ct.includes('mpegurl') || ct.includes('application/vnd.apple') || isM3u8Url(url);
}

function describeUrl(url) {
  try { return new URL(url).host; } catch { return '[invalid URL]'; }
}

function getProxiedUrl(baseUrl, upstreamUrl) {
  return `${baseUrl}/hls-proxy?url=${encodeURIComponent(upstreamUrl)}`;
}

function shouldRewriteUri(uri) {
  const trimmed = String(uri || '').trim();
  if (!trimmed) return false;
  return !/^(data|urn|skd):/i.test(trimmed);
}

function rewritePlaylistUri(baseUrl, playlistBase, uri) {
  if (!shouldRewriteUri(uri)) return uri;
  try {
    return getProxiedUrl(baseUrl, new URL(uri, playlistBase).toString());
  } catch {
    return uri;
  }
}

function rewritePlaylist(baseUrl, upstreamUrl, playlist) {
  return String(playlist).split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_, uri) =>
        `URI="${rewritePlaylistUri(baseUrl, upstreamUrl, uri)}"`);
    }
    return rewritePlaylistUri(baseUrl, upstreamUrl, trimmed);
  }).join('\n');
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range, If-Range, User-Agent',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type, Accept-Ranges, ETag, Last-Modified'
  };
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    const url = new URL(request.url);
    const baseUrl = url.origin;
    const path = url.pathname;

    if (path.startsWith('/play/')) {
      const channelId = path.slice('/play/'.length);
      try {
        const streamUrl = await resolveChannel(channelId);
        return await proxyStream(request, baseUrl, streamUrl);
      } catch (error) {
        const status = error.status === 400 ? 400 : error.status === 404 ? 404 : 502;
        console.log(`[geil] Yayın hatası: ${status}`);
        return new Response(`Yayın hatası: ${status}`, { status, headers: corsHeaders() });
      }
    }

    if (path === '/hls-proxy') {
      const upstreamUrl = url.searchParams.get('url');
      if (!upstreamUrl) {
        return new Response('URL parametresi eksik', { status: 400, headers: corsHeaders() });
      }
      try {
        const parsed = new URL(upstreamUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return new Response('Desteklenmeyen protokol', { status: 400, headers: corsHeaders() });
        }
        const ext = pathExtension(upstreamUrl);
        if (ext && !ALLOWED_EXTENSIONS.has(ext)) {
          return new Response('Desteklenmeyen dosya türü', { status: 403, headers: corsHeaders() });
        }
        return await proxyStream(request, baseUrl, upstreamUrl, true);
      } catch {
        return new Response('Proxy hatası', { status: 502, headers: corsHeaders() });
      }
    }
    return new Response('Kullanım: /play/<id>', { status: 404, headers: corsHeaders() });
  }
};

async function proxyStream(request, baseUrl, streamUrl, retryWithPlaylistHeaders = false) {
  // Resolve and fetch in the same request: CDN sessions can be requester-bound.
  const rangeHeaders = {};
  for (const name of ['Range', 'If-Range']) {
    const value = request.headers.get(name);
    if (value) rangeHeaders[name] = value;
  }
  let upstreamHeaders = getStreamHeaders();
  let response = await fetch(streamUrl, {
    headers: { ...upstreamHeaders, ...rangeHeaders }
  });

  if (retryWithPlaylistHeaders && (response.status === 403 || response.status === 401)) {
    await response.body?.cancel();
    upstreamHeaders = getPlaylistHeaders();
    response = await fetch(streamUrl, {
      headers: { ...upstreamHeaders, ...rangeHeaders }
    });
  }

  // Rewriting changes byte offsets, so an HLS manifest must be fetched whole.
  if (response.status === 206 && isM3u8Response(response.url || streamUrl, response.headers.get('content-type'))) {
    await response.body?.cancel();
    response = await fetch(streamUrl, { headers: upstreamHeaders });
  }

  console.log(`[geil] proxy ${describeUrl(streamUrl)} -> ${response.status}`);
  const headers = new Headers(corsHeaders());
  for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified', 'Cache-Control']) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  const contentType = response.headers.get('content-type') || '';
  const finalUrl = response.url || streamUrl;
  if (response.ok && isM3u8Response(finalUrl, contentType)) {
    if (response.status === 206) {
      await response.body?.cancel();
      return new Response('Yayın sunucusu eksik HLS listesi döndürdü', { status: 502, headers: corsHeaders() });
    }
    const playlist = await response.text();
    const rewritten = rewritePlaylist(baseUrl, finalUrl, playlist);
    for (const name of ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
      headers.delete(name);
    }
    headers.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    return new Response(rewritten, { status: response.status, headers });
  }
  return new Response(response.body, { status: response.status, headers });
}
