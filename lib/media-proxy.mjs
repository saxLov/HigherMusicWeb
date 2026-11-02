/* 同源音频转发层。服务端把已确认完整的 HTTPS 音源换成会话内随机 ticket。
 * 浏览器用 /api/audio?ticket=... 播放，支持进度拖动的 Range 请求，也让 Web Audio 可同源分析。 */
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

// 只为本次完整授权结果签发会话内随机凭据，客户端不能提交任意 URL。
/* mediaTickets()：只给完整允许播放的结果签发随机凭据；每个 ticket 绑定当前 session，1 小时有效，最多保存 512 项。
 * 返回给浏览器的是同源 URL，原平台地址保存在服务端 Map。 */
export function mediaTickets(session, result) {
  if (result.state !== 'allowed' || result.playbackState !== 'allowed') return result;
  session.media ??= new Map();
  const now = Date.now();
  for (const [key, value] of session.media)
    if (value.expires < now) session.media.delete(key);
  const urls = [
    ...new Set(
      [result.url, ...(result.urls || [])].filter(
        (x) => typeof x === 'string' && /^https:\/\//.test(x),
      ),
    ),
  ];
  const local = urls.map((url) => {
    const key = randomBytes(24).toString('hex');
    session.media.set(key, { url, expires: now + 60 * 60 * 1000 });
    return '/api/audio?ticket=' + key;
  });
  while (session.media.size > 512)
    session.media.delete(session.media.keys().next().value);
  return local.length ? { ...result, url: local[0], urls: local } : result;
}
/* proxyAudio()：校验账号、ticket 与有效期，再以流转发音频；支持单段 bytes Range，便于拖动进度。
 * 客户端断开会中止上游请求；fetcher 可注入测试，不能从客户端直接提交任意 URL。 */
export async function proxyAudio(req, res, session, ticket, fetcher = fetch) {
  const source = session.media?.get(ticket);
  if (!session.user || !source || source.expires < Date.now()) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '播放凭据失效，请重新播放' }));
    return;
  }
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    /* 只支持单段 bytes 请求；原样转发合法 Range，并保留上游 Content-Range/Accept-Ranges。 */
    const range = req.headers.range;
    if (range && !/^bytes=\d*-\d*$/.test(range)) {
      res.writeHead(416);
      res.end();
      return;
    }
    const upstream = await fetcher(source.url, {
      headers: range ? { Range: range } : {},
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (![200, 206, 416].includes(upstream.status)) {
      res.writeHead(502);
      res.end();
      return;
    }
    const headers = {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'private, no-store',
    };
    for (const name of [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
    ]) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }
    res.writeHead(upstream.status, headers);
    if (upstream.body) {
      const stream = Readable.fromWeb(upstream.body);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } else res.end();
  } catch {
    if (!res.headersSent) {
      res.writeHead(502);
      res.end();
    } else res.destroy();
  } finally {
    clearTimeout(timer);
  }
}
