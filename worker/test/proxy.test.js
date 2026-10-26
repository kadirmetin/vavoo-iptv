import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.js';

const mediaUrl = 'https://origin.example/start';
const routes = [
  '/play/406666682',
  `/hls-proxy?url=${encodeURIComponent(mediaUrl)}`
];

function setup(t, mediaFetch) {
  const previousKV = globalThis.VAVOO_KV;
  t.after(() => {
    if (previousKV === undefined) delete globalThis.VAVOO_KV;
    else globalThis.VAVOO_KV = previousKV;
  });
  const env = {
    VAVOO_KV: {
      async get(key) {
        throw new Error(`Geil playback must not require KV: ${key}`);
      }
    }
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const parsed = new URL(url);
    if (parsed.origin === 'https://geil.to' && parsed.pathname === '/live/resolve') {
      assert.equal(parsed.searchParams.get('url'), 'https://geil.to/live/play/406666682');
      return Response.json({ url: mediaUrl });
    }
    assert.equal(url, mediaUrl);
    return mediaFetch(options);
  });
  return (route, headers = {}) => worker.fetch(new Request(`https://proxy.example${route}`, { headers }), env);
}

for (const route of routes) {
  const label = route.startsWith('/play/') ? '/play' : '/hls-proxy';

  test(`${label} forwards byte ranges and preserves partial response headers`, async (t) => {
    const handle = setup(t, (options) => {
      const headers = new Headers(options.headers);
      assert.equal(headers.get('range'), 'bytes=100-103');
      assert.equal(headers.get('if-range'), '"version-1"');
      assert.equal(headers.get('user-agent'), 'VAVOO/2.6');
      assert.equal(headers.get('origin'), 'https://geil.to');
      assert.equal(headers.get('referer'), 'https://geil.to/');
      return new Response('part', {
        status: 206,
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Range': 'bytes 100-103/1000',
          'Accept-Ranges': 'bytes',
          ETag: '"version-1"',
          'Last-Modified': 'Mon, 26 Oct 2026 00:00:00 GMT',
          'Cache-Control': 'private, no-store'
        }
      });
    });
    const response = await handle(route, { Range: 'bytes=100-103', 'If-Range': '"version-1"' });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 100-103/1000');
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('etag'), '"version-1"');
    assert.equal(response.headers.get('last-modified'), 'Mon, 26 Oct 2026 00:00:00 GMT');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(await response.text(), 'part');
  });

  test(`${label} resolves playlist URIs against the final redirect URL`, async (t) => {
    const handle = setup(t, () => {
      const response = new Response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="keys/key.key"\nsegment.ts\n', {
        headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': '999', ETag: '"upstream"' }
      });
      Object.defineProperty(response, 'url', { value: 'https://cdn.example/final/master.m3u8' });
      return response;
    });
    const response = await handle(route);
    const playlist = await response.text();
    assert.ok(playlist.includes('https://proxy.example/hls-proxy?url=https%3A%2F%2Fcdn.example%2Ffinal%2Fsegment.ts'));
    assert.ok(playlist.includes('URI="https://proxy.example/hls-proxy?url=https%3A%2F%2Fcdn.example%2Ffinal%2Fkeys%2Fkey.key"'));
    assert.equal(response.headers.get('content-length'), null);
    assert.equal(response.headers.get('etag'), null);
    assert.match(response.headers.get('cache-control'), /no-store/);
  });

  test(`${label} retains Content-Range on an unsatisfiable range`, async (t) => {
    const handle = setup(t, () => new Response(null, {
      status: 416, headers: { 'Content-Range': 'bytes */1000' }
    }));
    const response = await handle(route, { Range: 'bytes=2000-' });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), 'bytes */1000');
  });

  test(`${label} fetches a complete playlist before rewriting a ranged HLS response`, async (t) => {
    const ranges = [];
    const handle = setup(t, (options) => {
      ranges.push(new Headers(options.headers).get('range'));
      const partial = ranges.length === 1;
      return new Response(partial ? 'gment.ts' : '#EXTM3U\nsegment.ts\n', {
        status: partial ? 206 : 200,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          ...(partial ? { 'Content-Range': 'bytes 10-17/100' } : {})
        }
      });
    });
    const response = await handle(route, { Range: 'bytes=10-17', 'If-Range': '"version-1"' });
    assert.deepEqual(ranges, ['bytes=10-17', null]);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-range'), null);
    assert.ok((await response.text()).includes('url=https%3A%2F%2Forigin.example%2Fsegment.ts'));
  });

  test(`${label} rejects a playlist that stays partial without a Range request`, async (t) => {
    const handle = setup(t, () => new Response('gment.ts', {
      status: 206,
      headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Range': 'bytes 10-17/100' }
    }));
    const response = await handle(route, { Range: 'bytes=10-17' });
    assert.equal(response.status, 502);
  });
}

for (const status of [401, 403]) {
  test(`/hls-proxy keeps Range when retrying ${status} with playlist headers`, async (t) => {
    const agents = [];
    const handle = setup(t, (options) => {
      const headers = new Headers(options.headers);
      agents.push(headers.get('user-agent'));
      assert.equal(headers.get('range'), 'bytes=0-3');
      if (agents.length === 1) return new Response('denied', { status });
      return new Response('part', { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-3/1000' } });
    });
    const response = await handle(routes[1], { Range: 'bytes=0-3' });
    assert.deepEqual(agents, ['VAVOO/2.6', 'libmpv']);
    assert.equal(response.status, 206);
    assert.equal(await response.text(), 'part');
  });
}

test('/play keeps its existing no-header-fallback policy', async (t) => {
  let attempts = 0;
  const handle = setup(t, () => { attempts++; return new Response('denied', { status: 403 }); });
  assert.equal((await handle(routes[0])).status, 403);
  assert.equal(attempts, 1);
});

test('/hls-proxy rejects unsupported target schemes and extensions before fetching', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Must not fetch invalid targets'); });
  for (const [url, status] of [['file:///video.ts', 400], ['https://cdn.example/script.js', 403]]) {
    const response = await worker.fetch(new Request(`https://proxy.example/hls-proxy?url=${encodeURIComponent(url)}`), {});
    assert.equal(response.status, status);
  }
});

for (const [upstreamStatus, expected] of [[404, 404], [503, 502]]) {
  test(`/play maps upstream ${upstreamStatus} to ${expected}, without another source`, async (t) => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async input => {
      const url = new URL(input);
      calls.push(url.hostname);
      return new Response(null, { status: upstreamStatus });
    });
    const response = await worker.fetch(new Request('https://proxy.example/play/406666682'), {});
    assert.equal(response.status, expected);
    assert.ok(calls.length > 0);
    assert.ok(calls.every(host => host === 'geil.to'));
  });
}

test('/play rejects malformed IDs before contacting a provider', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('must not fetch'); });
  const response = await worker.fetch(new Request('https://proxy.example/play/not-a-channel'), {});
  assert.equal(response.status, 400);
});

test('playback logs never expose signed media paths or query tokens', async (t) => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  t.mock.method(globalThis, 'fetch', async input => {
    if (new URL(input).hostname === 'geil.to') {
      return Response.json({ url: 'https://cdn.example/sunshine/private-path/hls/index.m3u8?token=private-token' });
    }
    return new Response('#EXTM3U\nsegment.ts', { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  });
  const response = await worker.fetch(new Request('https://proxy.example/play/406666682'), {});
  assert.equal(response.status, 200);
  assert.ok(!logs.join('\n').includes('private-path'));
  assert.ok(!logs.join('\n').includes('private-token'));
});
