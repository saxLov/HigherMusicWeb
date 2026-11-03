import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPreview } from '../scripts/preview.mjs';
import http from 'node:http';

test('真实HTTP链路：扫码会话、检查摘要、独立历史上报、重复/跨账号拒绝、退出失效', async () => {
  const { server, calls } = createPreview();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const initial = await fetch(base + '/api/session');
    const cookie = initial.headers.get('set-cookie').split(';')[0];
    const send = async (route, method = 'GET', body, extra = {}) => {
      const response = await fetch(base + route, { method, headers: { Cookie: cookie,
        ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() };
    };
    await send('/api/login', 'POST'); await send('/api/login/status');
    await send('/api/playlists');
    const tracks = (await send('/api/tracks?playlist=1')).body.tracks;
    const track = tracks[0];
    const body = { songId: track.id, hash: track.hash, playbackId: '12345678-1234-1234-1234-123456789012' };
    assert.equal((await send('/api/report_history', 'POST', body)).status, 403);
    const checked = await send('/api/inspect?track=' + encodeURIComponent(track.id), 'POST');
    assert.equal(checked.body.playable, true); assert.equal(checked.body.url, undefined);
    assert.equal(calls.filter((x) => x.name === 'playhistory_upload').length, 0);
    const submitted = await send('/api/report_history', 'POST', body);
    assert.equal(submitted.body.accepted, true);
    assert.equal((await send('/api/report_history', 'POST', body)).body.skipped, 'duplicate');
    assert.equal(calls.filter((x) => x.name === 'playhistory_upload').length, 1);
    assert.deepEqual(calls.find((x) => x.name === 'playhistory_upload').params, { mxid: 1001 });
    const anonymous = await fetch(base + '/api/report_history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(anonymous.status, 401);
    assert.equal((await send('/api/report_history', 'POST', body, { Origin: 'https://other.invalid' })).status, 403);
    const played = await send('/api/play?track=' + encodeURIComponent(track.id), 'POST');
    assert.match(played.body.url, /^\/api\/audio\?ticket=/);
    assert.equal(calls.filter((x) => x.name === 'playhistory_upload').length, 1);
    // 请求体只到一半时退出，旧会话不能在请求体补齐后上报。
    const payload = JSON.stringify(body);
    const opened = new Promise((resolve) => server.once('request', resolve));
    let partial;
    const delayed = new Promise((resolve, reject) => {
      partial = http.request(base + '/api/report_history', {
        method: 'POST', headers: {
          Cookie: cookie, 'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      partial.on('error', reject);
      partial.write(payload.slice(0, 20));
    });
    await opened;
    await send('/api/logout', 'POST');
    partial.end(payload.slice(20));
    assert.equal(await delayed, 401);
    assert.equal((await send('/api/report_history', 'POST', body)).status, 401);
    for (const file of ['player-core.js', 'api-client.js', 'listening.js', 'lyrics.js', 'backgrounds.js', 'search.js', 'styles/base.css', 'styles/player.css', 'styles/lyrics.css']) {
      assert.equal((await fetch(base + '/' + file)).status, 200, file);
    }
  } finally { await new Promise((r) => server.close(r)); }
});
