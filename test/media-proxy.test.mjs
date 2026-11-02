/* 自动检查：同源音频：会话 ticket、有效期、Range、流式响应及账号隔离。
 * 使用 Node 内置 node:test 与 assert；每个中文 test 标题说明场景，assert 是预期结果。
 * 桩数据用于可重复的本地验证，不代表平台当次真实权益；运行 node --test test/*.test.mjs。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { once } from 'node:events';
import { mediaTickets, proxyAudio } from '../lib/media-proxy.mjs';
test('只有完整授权结果签发同源音频凭据，凭据不跨账号复用', async () => {
  const a = { user: {} },
    b = { user: {} },
    unknown = { state: 'unknown', url: 'https://example.com/a' };
  assert.equal(mediaTickets(a, unknown), unknown);
  const result = mediaTickets(a, {
    state: 'allowed',
    playbackState: 'allowed',
    url: 'https://example.com/a',
    urls: ['https://example.com/a'],
  });
  assert.equal(result.urls.length, 1);
  assert.match(result.url, /^\/api\/audio\?ticket=[a-f0-9]{48}$/);
  const key = result.url.split('=')[1];
  assert.equal(a.media.get(key).url, 'https://example.com/a');
  assert.equal(b.media, undefined);
  let fetched = false;
  const res = {
    writeHead(code) {
      this.code = code;
    },
    end() {},
  };
  await proxyAudio({ headers: {} }, res, b, key, () => {
    fetched = true;
  });
  assert.equal(res.code, 403);
  assert.equal(fetched, false);
});
test('音频转发支持 Range、流式输出和过期拒绝，不接收客户端 URL', async () => {
  const s = { user: {} };
  const { url } = mediaTickets(s, {
    state: 'allowed',
    playbackState: 'allowed',
    url: 'https://example.com/song',
  });
  const key = url.split('=')[1],
    parts = [];
  const res = new Writable({
    write(chunk, _, next) {
      parts.push(chunk);
      next();
    },
  });
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers;
  };
  let request;
  const done = once(res, 'finish');
  await proxyAudio(
    { headers: { range: 'bytes=2-5' } },
    res,
    s,
    key,
    async (address, options) => {
      request = { address, options };
      return new Response('abcd', {
        status: 206,
        headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 2-5/10' },
      });
    },
  );
  await done;
  assert.equal(request.options.headers.Range, 'bytes=2-5');
  assert.equal(res.status, 206);
  assert.equal(Buffer.concat(parts).toString(), 'abcd');
  assert.equal(res.headers['content-range'], 'bytes 2-5/10');
  s.media.get(key).expires = 0;
  const expired = {
    writeHead(code) {
      this.code = code;
    },
    end() {},
  };
  await proxyAudio({ headers: {} }, expired, s, key);
  assert.equal(expired.code, 403);
});
