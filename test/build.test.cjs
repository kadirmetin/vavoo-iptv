const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function runBuild(t, empty) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'geil-build-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  await fs.cp(path.join(__dirname, '../scripts'), path.join(temp, 'scripts'), { recursive: true });
  try { await fs.cp(path.join(__dirname, '../lib'), path.join(temp, 'lib'), { recursive: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.writeFile(path.join(temp, 'iptv.m3u'), 'previous playlist');
  await fs.writeFile(path.join(temp, 'epg.xml'), 'previous guide');
  await fs.writeFile(path.join(temp, 'mock-fetch.cjs'), `
global.fetch = async input => {
  const url = new URL(input);
  if (url.hostname === 'geil.to') {
    if (url.pathname !== '/live/catalog/live/channels.json') throw new Error('Wrong Geil API');
    return Response.json({items: ${empty ? '[]' : JSON.stringify([{ id: '406666682', name: 'TRT 1 FHD (1)', type: 'live', url: 'https://geil.to/live/play/406666682', epg: [{ title: 'News & weather', start: '2026-10-26T00:00:00Z', end: '2026-10-26T01:00:00Z' }] }])}, nextCursor:null});
  }
  if (url.hostname === 'vavoo.to' || url.hostname === 'kool.to') throw new Error('Old source must never be called');
  if (url.hostname === 'epgshare01.online') return new Response('<tv></tv>');
  if (url.hostname === 'iptv-org.github.io') return Response.json([]);
  throw new Error('Unexpected network request');
};
`);
  const child = spawn(process.execPath, ['--require', './mock-fetch.cjs', './scripts/build.js'], {
    cwd: temp, env: { ...process.env, PROXY_BASE: 'https://proxy.example', IPTVORG_GRAB_DIR: '',
      EPG_UPSTREAM_URL: 'https://epgshare01.online/empty.xml',
      IPTVORG_CHANNELS_URL: 'https://iptv-org.github.io/api/channels.json',
      IPTVORG_LOGOS_URL: 'https://iptv-org.github.io/api/logos.json' }
  });
  let output = '';
  child.stdout.on('data', data => output += data);
  child.stderr.on('data', data => output += data);
  const timer = setTimeout(() => child.kill('SIGTERM'), 25000);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  clearTimeout(timer);
  return { code, output, playlist: await fs.readFile(path.join(temp, 'iptv.m3u'), 'utf8'),
    guide: await fs.readFile(path.join(temp, 'epg.xml'), 'utf8') };
}

test('actual build preserves Geil IDs and converts inline EPG into XMLTV', async (t) => {
  const result = await runBuild(t, false);
  assert.equal(result.code, 0, result.output);
  assert.match(result.playlist, /tvg-id="406666682"/);
  assert.match(result.playlist, /https:\/\/proxy\.example\/play\/406666682/);
  assert.match(result.guide, /channel id="406666682"/);
  assert.match(result.guide, /start="20261026000000 \+0000" stop="20261026010000 \+0000" channel="406666682"/);
  assert.match(result.guide, /News &amp; weather/);
});

test('empty Geil catalogue fails the actual build without overwriting old outputs', async (t) => {
  const result = await runBuild(t, true);
  assert.notEqual(result.code, 0);
  assert.equal(result.playlist, 'previous playlist');
  assert.equal(result.guide, 'previous guide');
});
