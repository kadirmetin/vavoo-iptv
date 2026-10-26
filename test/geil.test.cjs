const assert = require('node:assert/strict');
const { test } = require('node:test');
const geil = require('../lib/geil.cjs');

const channel = {
  id: '406666682', name: 'TRT 1 FHD (1)', type: 'live',
  url: 'https://geil.to/live/play/406666682', tags: ['Turkey'],
  ids: { tvg: 'TRT1.tr' },
  epg: [
    { title: 'News', start: '2026-10-26T00:00:00Z', end: '2026-10-26T01:00:00Z' },
    { title: 'Bad date', start: 'invalid', end: 'invalid' },
    { title: 'Backwards', start: '2026-10-26T02:00:00Z', end: '2026-10-26T01:00:00Z' }
  ]
};

test('catalogue pages use only Geil v2, retain IDs and normalize inline EPG', async (t) => {
  const cursors = [];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://geil.to');
    assert.equal(url.pathname, '/live/catalog/live/channels.json');
    assert.equal(url.searchParams.get('filter[group]'), 'Turkey');
    assert.equal(url.searchParams.get('sort'), 'name');
    assert.ok(!options.method || options.method === 'GET');
    assert.equal(options.redirect, 'manual');
    cursors.push(url.searchParams.get('cursor'));
    return Response.json(cursors.length === 1
      ? { items: [channel], nextCursor: '300' }
      : { items: [{ ...channel, id: '1221669131', name: 'TRT 1 HD (1)' }], nextCursor: null });
  });
  const channels = await geil.fetchChannels();
  assert.deepEqual(cursors, [null, '300']);
  assert.deepEqual(channels.map(x => x.ids.id), ['406666682', '1221669131']);
  assert.equal(channels[0].ids.tvg, 'TRT1.tr');
  assert.equal(channels[0].url, 'https://geil.to/live/play/406666682');
  assert.deepEqual(channels[0].epg, [{ name: 'News', start: 1792972800, stop: 1792976400 }]);
});

for (const [name, response] of [
  ['empty catalogue', { items: [], nextCursor: null }],
  ['missing items', {}],
  ['non-array items', { items: {} }],
  ['missing channel ID', { items: [{ name: 'TRT 1' }] }]
]) {
  test(`rejects ${name} rather than publishing a broken list`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => Response.json(response));
    await assert.rejects(geil.fetchChannels());
  });
}

test('rejects a repeated cursor instead of returning a partial catalogue', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ items: [channel], nextCursor: 'again' });
  });
  await assert.rejects(geil.fetchChannels(), /cursor/i);
  assert.equal(calls, 2);
});

test('a later page failure rejects the whole catalogue without old-source fallback', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input) => {
    assert.equal(new URL(input).hostname, 'geil.to');
    return ++calls === 1 ? Response.json({ items: [channel], nextCursor: '300' })
      : new Response('Unavailable', { status: 503 });
  });
  await assert.rejects(geil.fetchChannels(), error => error.status === 503);
});

test('rejects malformed JSON', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('not JSON'));
  await assert.rejects(geil.fetchChannels());
});

test('rejects source redirects using the Workers-supported manual mode', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    calls++;
    assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'https://vavoo.to/catalog' } });
  });
  await assert.rejects(geil.fetchChannels(), error => error.status === 302);
  assert.equal(calls, 1);
});

test('skips malformed EPG timestamps without coercion or calendar rollover', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ items: [{
    ...channel,
    epg: [
      { title: 'Numeric', start: 0, end: 1 },
      { title: 'Short strings', start: '0', end: '1' },
      { title: 'Invalid day', start: '2026-02-30T00:00:00Z', end: '2026-03-04T00:00:00Z' },
      { title: 'Invalid hour', start: '2026-10-26T24:00:00Z', end: '2026-10-28T00:00:00Z' },
      { title: 'Missing zone', start: '2026-10-26T00:00:00', end: '2026-10-26T01:00:00' },
      { title: 'Timezone', start: '2026-10-26T03:00:00+03:00', end: '2026-10-26T04:00:00+03:00' }
    ]
  }], nextCursor: null }));
  const channels = await geil.fetchChannels();
  assert.deepEqual(channels[0].epg, [{ name: 'Timezone', start: 1792972800, stop: 1792976400 }]);
});

test('resolves an ID via Geil v2 GET without signatures or arbitrary target URLs', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://geil.to');
    assert.equal(url.pathname, '/live/resolve');
    assert.equal(url.searchParams.get('url'), 'https://geil.to/live/play/406666682');
    assert.ok(!options.method || options.method === 'GET');
    assert.equal(new Headers(options.headers).get('mediahubmx-signature'), null);
    return Response.json({ url: 'http://31.43.191.154:8008/playlist.m3u8' });
  });
  assert.equal(await geil.resolveChannel('406666682'), 'http://31.43.191.154:8008/playlist.m3u8');
});

for (const status of [404, 503]) {
  test(`keeps upstream ${status} distinguishable`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(null, { status }));
    await assert.rejects(geil.resolveChannel('406666682'), error => error.status === status);
  });
}

test('rejects invalid IDs before making any upstream request', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('must not fetch'); });
  for (const id of ['', '../catalog', 'https://evil.example/', '406666682?x=1']) {
    await assert.rejects(geil.resolveChannel(id), error => error.status === 400);
  }
});

for (const url of [undefined, '', 'file:///secret', 'javascript:alert(1)', 'https://user:pass@cdn.example/live.m3u8']) {
  test(`rejects invalid resolved stream ${String(url)}`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ url }));
    await assert.rejects(geil.resolveChannel('406666682'));
  });
}
