/* 自动检查：同源 HTTP 服务：静态资源白名单、会话隔离、跨站拒绝、匿名限制和退出。
 * 使用 Node 内置 node:test 与 assert；每个中文 test 标题说明场景，assert 是预期结果。
 * 桩数据用于可重复的本地验证，不代表平台当次真实权益；运行 node --test test/*.test.mjs。 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { server } from '../server.mjs';
let base;
/* 测试开始前把导入的服务监听在随机空闲端口，避免影响真实 3211 播放器。 */
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
/* 测试结束后关闭临时服务，释放监听端口与连接。 */
after(() => new Promise((r) => server.close(r)));
test('同源整合页托管九卡片 HTML、JS 和 CSS，脚本不含固定端口', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.equal((html.match(/<figure\b/g) || []).length, 9);
  assert.match(html, /<script\s+src="\/app.js"\s+defer\s*>/);
  const js = await fetch(base + '/app.js');
  assert.equal(js.status, 200);
  assert.match(await js.text(), /const API_BASE = '';/);
  assert.equal((await fetch(base + '/style.css')).status, 200);
  assert.ok(r.headers.get('content-security-policy').includes("script-src 'self'"));
});
test('两个浏览器获得不同的 HttpOnly 会话', async () => {
  const a = await fetch(base + '/api/session');
  const b = await fetch(base + '/api/session');
  assert.notEqual(a.headers.get('set-cookie'), b.headers.get('set-cookie'));
  assert.match(a.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await a.json()).user, null);
});
test('跨站登录请求被拒绝', async () => {
  const r = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { Origin: 'https://attacker.example' },
  });
  assert.equal(r.status, 403);
});
test('匿名请求不能读取歌单', async () => {
  const r = await fetch(base + '/api/playlists');
  assert.notEqual(r.status, 200);
  assert.match((await r.json()).error, /登录/);
});
test('私有文件不会被静态服务暴露', async () => {
  for (const file of ['/server.mjs', '/.env', '/REQUIREMENTS.md', '/.runtime/kugou.zip'])
    assert.equal((await fetch(base + file)).status, 404);
});
test('退出后旧会话被替换', async () => {
  const first = await fetch(base + '/api/session');
  const cookie = first.headers.get('set-cookie').split(';')[0];
  await fetch(base + '/api/logout', { method: 'POST', headers: { Cookie: cookie } });
  const next = await fetch(base + '/api/session', { headers: { Cookie: cookie } });
  assert.ok(next.headers.get('set-cookie'));
  assert.notEqual(next.headers.get('set-cookie').split(';')[0], cookie);
});
