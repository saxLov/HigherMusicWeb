/* Node HTTP 服务入口：同源托管 public 页面、API、背景图片和带会话凭据的音频流。
 * 运行 npm start 或 node server.mjs；默认只监听 127.0.0.1:3211。
 * 登录凭证只存在内存 sessions，重启后需扫码；前端拿到的是会话 Cookie，不是平台 token。
 * 阅读顺序：连接组件包装 → 会话配置 → 静态资源 → 来源校验/会话 → 登录 → 已登录接口。 */
import http from 'node:http';
import { createHistoryReporter, readHistoryBody, HistoryError } from './lib/history.mjs';
import { createInspector } from './lib/inspection.mjs';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { mediaTickets, proxyAudio } from './lib/media-proxy.mjs';
import {
  frontendRoot,
  backgrounds,
  backgroundFile,
  artwork,
  lyrics,
} from './lib/gallery.mjs';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ready } from './lib/provider.mjs';
import { collectPages } from './lib/pagination.mjs';
import {
  unauthorizedId,
  registerTracks,
  unauthorizedTracks,
  localPlaylist,
  recordAccess,
} from './lib/library.mjs';
/* providerCall()：懒加载 provider 适配层再转发参数；保持路由代码不直接依赖第三方组件。 */
async function providerCall(...args) {
  return (await loadAdapter('provider')).call(...args);
}
/* loadAdapter()：以模块文件修改时间作为 import 查询参数，文件更新后可读取新版本；不扫描任意客户端路径。 */
async function loadAdapter(name) {
  const url = new URL(`./lib/${name}.mjs`, import.meta.url);
  const file = await stat(url);
  return import(url.href + '?v=' + file.mtimeMs);
}
/* 【服务配置】内存会话表；port/host 可由 PORT/HOST 环境变量调整，publicRoot 固定指向 public。 */
const port = Number(process.env.PORT || 3211);
const host = process.env.HOST || '127.0.0.1';
export function createMusicServer({
  request = providerCall,
  inspectAccess,
  adapters = loadAdapter,
  audioProxy = proxyAudio,
} = {}) {
const call = request;
const adapter = adapters;
const reportHistory = createHistoryReporter(call);
const inspect = createInspector(inspectAccess || (async (...args) =>
  (await adapter('access')).checkAccess(...args)));
const sessions = new Map();
const publicRoot = new URL('./public/', import.meta.url);
/* 会话闲置 4 小时过期；每分钟清理一次，unref 避免清理计时器单独阻止进程退出。 */
const expiry = 4 * 60 * 60 * 1000;
const cleanup = setInterval(() => {
  for (const [key, s] of sessions)
    if (Date.now() - s.touched > expiry) sessions.delete(key);
}, 60000).unref();
/* json()：统一写入 JSON 响应状态、UTF-8 Content-Type 和序列化数据。 */
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
/* requireLogin()：只允许已有 s.user 的会话访问账号数据；未登录时由外层统一返回错误。 */
function requireLogin(s) {
  if (!s.user) throw new Error('请先扫码登录。');
}
/* pages()：将平台分页接口包装为完整读取；s 是当前会话，method 是连接组件接口名。 */
async function pages(s, method, params = {}) {
  return collectPages((page, pagesize) => call(s, method, { ...params, page, pagesize }));
}
/* 【HTTP 入口】先处理静态资源，再处理 /api/。测试可导入 server 并监听临时端口。 */
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  /* 内容安全策略：脚本默认仅同源，图片/媒体可使用 HTTPS；兼容已有内联脚本时按实际内容签 SHA-256。 */
  const policy = (hash) =>
    `default-src 'self'; img-src 'self' data: https:; media-src 'self' https:; style-src 'self' 'unsafe-inline'; script-src 'self' ${hash ? `'sha256-${hash}'` : ''}; frame-ancestors 'none'; base-uri 'none'`;
  res.setHeader('Content-Security-Policy', policy());
  const u = new URL(req.url, 'http://localhost');
  try {
    /* 【静态资源】只开放白名单中的页面/脚本/样式和验证后的背景图片；不会把整个磁盘目录公开。 */
    if (!u.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') return json(res, 405, { error: '不支持的操作' });
      if (u.pathname.startsWith('/Image169/')) {
        const image = await backgroundFile(
          decodeURIComponent(u.pathname.slice('/Image169/'.length)),
        );
        if (!image) return json(res, 404, { error: '背景图片不存在' });
        res.setHeader('Content-Type', image.type);
        return res.end(image.data);
      }
      if (u.pathname === '/' || u.pathname === '/index.html') {
        const html = await readFile(path.join(frontendRoot, 'index.html'), 'utf8');
        const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
        res.setHeader(
          'Content-Security-Policy',
          policy(script ? createHash('sha256').update(script).digest('base64') : ''),
        );
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(html);
      }
      /* 浏览器可下载的静态文件白名单；新增前端文件时需同时在这里登记路径。 */
      const paths = {
        '/': 'index.html',
        '/app.js': 'app.js',
        '/visualizer.js': 'visualizer.js',
        '/media.mjs': 'media.mjs',
        '/track-state.mjs': 'track-state.mjs',
        '/queue.mjs': 'queue.mjs',
        '/style.css': 'style.css',
        '/player-core.js': 'player-core.js',
        '/listening.js': 'listening.js',
        '/api-client.js': 'api-client.js',
        '/lyrics.js': 'lyrics.js',
        '/backgrounds.js': 'backgrounds.js',
        '/search.js': 'search.js',
        '/styles/base.css': 'styles/base.css',
        '/styles/player.css': 'styles/player.css',
        '/styles/lyrics.css': 'styles/lyrics.css',
      };
      const file = paths[u.pathname];
      if (!file) return json(res, 404, { error: '页面不存在' });
      const data = await readFile(new URL(file, publicRoot));
      res.setHeader(
        'Content-Type',
        file.endsWith('.html')
          ? 'text/html; charset=utf-8'
          : file.endsWith('.css')
            ? 'text/css'
            : 'text/javascript',
      );
      return res.end(data);
    }
    /* 【请求来源】API 只接受本站来源或显式 PUBLIC_ORIGIN；跨站请求拒绝，避免别的网站代替用户操作会话。 */
    const origin = req.headers.origin;
    if (
      origin &&
      origin !== `http://${req.headers.host}` &&
      origin !== process.env.PUBLIC_ORIGIN
    )
      return json(res, 403, { error: '请求来源无效' });
    if (req.headers['sec-fetch-site'] === 'cross-site')
      return json(res, 403, { error: '请求来源无效' });
    /* 【会话】Cookie 只含随机 session ID；平台 Cookie/token 在服务端 s.jar 内保存。 */
    let sid = req.headers.cookie?.match(
      /(?:^|;\s*)music_session=([a-f0-9]{48})(?:;|$)/,
    )?.[1];
    let s = sessions.get(sid);
    if (!s || Date.now() - s.touched > expiry) {
      if (sid) sessions.delete(sid);
      sid = randomBytes(24).toString('hex');
      s = { jar: {}, touched: Date.now(), tracks: new Map(), playlists: new Map() };
      sessions.set(sid, s);
      res.setHeader(
        'Set-Cookie',
        `music_session=${sid}; HttpOnly; SameSite=Strict; Path=/${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`,
      );
    }
    s.touched = Date.now();
    const action = `${req.method} ${u.pathname}`;
    /* 公开会话摘要，用于页面启动；只返回组件是否就绪与用户展示名，不返回平台凭证。 */
    if (action === 'GET /api/session')
      return json(res, 200, { ready: ready(), user: s.user ?? null });
    /* 音频流单独验证 ticket，不占会话业务锁，避免正在播放时阻塞其他 API。 */
    if (action === 'GET /api/audio')
      return audioProxy(req, res, s, u.searchParams.get('ticket'));
    /* 销毁服务端会话并让浏览器 Cookie 过期，旧音频凭据也随会话失效。 */
    if (action === 'POST /api/logout') {
      sessions.delete(sid);
      res.setHeader(
        'Set-Cookie',
        'music_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
      );
      return json(res, 200, { ok: true });
    }
    // 独立历史上报使用账号级专用限流，不占播放/歌单业务锁。
    if (action === 'POST /api/report_history') {
      if (!s.user) return json(res, 401, { error: '请先扫码登录' });
      const body = await readHistoryBody(req);
      // 读取请求体期间另一标签页可能已经退出；旧 session 不能再发起上报。
      if (sessions.get(sid) !== s || !s.user) return json(res, 401, { error: '登录已失效' });
      return json(res, 200, await reportHistory(s, body));
    }
    /* 【会话业务锁】同一账号操作串行执行；finally 一定释放。前端 request 队列与此配合。 */
    if (s.busy) return json(res, 429, { error: '上一个操作尚未完成，请稍候。' });
    s.busy = true;
    try {
      /* 【二维码登录】生成 key 后取二维码图，5 秒内不允许反复刷新，二维码有效期由后续轮询检查。 */
      if (action === 'POST /api/login') {
        if (s.user) throw new Error('请先退出当前账号。');
        if (s.lastQR && Date.now() - s.lastQR < 5000)
          throw new Error('请稍候再刷新二维码。');
        s.lastQR = Date.now();
        const b = await call(s, 'login_qr_key');
        s.qr = b.data?.qrcode ?? b.data?.key;
        if (!s.qr) throw new Error('二维码接口格式尚未适配。');
        const qr = await call(s, 'login_qr_create', { key: s.qr, qrimg: true });
        s.qrTime = Date.now();
        return json(res, 200, { image: qr.data?.base64 });
      }
      /* 轮询间隔至少 2 秒；二维码最长使用 3 分钟，状态 4 才把平台 token/userid 写入当前会话。 */
      if (action === 'GET /api/login/status') {
        if (!s.qr || Date.now() - s.qrTime > 180000) return json(res, 200, { status: 0 });
        if (s.lastPoll && Date.now() - s.lastPoll < 2000)
          return json(res, 200, { status: 1 });
        s.lastPoll = Date.now();
        const b = await call(s, 'login_qr_check', { key: s.qr });
        const d = b.data;
        if (d?.status === 4 || d?.status === '4') {
          if (!d.token || !d.userid) throw new Error('登录凭证不完整，请重新扫码。');
          s.jar.token = d.token;
          s.jar.userid = d.userid;
          s.user = { name: d.nickname || d.username || '酷狗用户' };
          s.qr = null;
        }
        return json(res, 200, { status: Number(d?.status), user: s.user ?? null });
      }
      /* 【登录分界】下面所有接口都必须已扫码；背景列表、封面、歌词同样受会话限制。 */
      requireLogin(s);
      /* 返回 public/Image169 可用图片文件名；图片二进制由上面的静态资源分支提供。 */
      if (action === 'GET /api/backgrounds')
        return json(res, 200, { images: await backgrounds() });
      /* 封面与歌词只能查询已登记在当前账号歌单里的 track，不能提交任意平台标识。 */
      if (action === 'GET /api/cover' || action === 'GET /api/lyrics') {
        const track = s.tracks.get(u.searchParams.get('track'));
        if (!track) return json(res, 404, { error: '请先选择本账号的歌单' });
        if (action === 'GET /api/cover')
          return json(res, 200, { cover: await artwork(s, track, call) });
        return json(res, 200, { lyrics: await lyrics(s, track, call) });
      }
      /* 账号字段诊断入口，输出经过脱敏的结构摘要。 */
      if (action === 'GET /api/account-diagnostics') {
        const mod = await adapter('account');
        return json(res, 200, await mod.diagnostics(s, call));
      }
      /* 兼容旧诊断入口；递归限制深度、缩减数组样本并过滤凭证字段。 */
      if (action === 'GET /api/legacy-diagnostics') {
        const shape = (v, depth = 0) => {
          if (depth > 6) return '…';
          if (Array.isArray(v))
            return {
              length: v.length,
              sample: v.slice(0, 1).map((x) => shape(x, depth + 1)),
            };
          if (v && typeof v === 'object')
            return Object.fromEntries(
              Object.entries(v)
                .filter(([k]) => !/token|cookie|auth|userid|openid|url/i.test(k))
                .map(([k, x]) => [k, shape(x, depth + 1)]),
            );
          return typeof v === 'string' ? `string(${v.length})` : v;
        };
        const output = {};
        for (const name of [
          'user_purchased_songs',
          'user_purchased_albums',
          'user_vip_detail',
        ]) {
          try {
            output[name] = shape(await call(s, name, { page: 1, pagesize: 100 }));
          } catch (e) {
            output[name] = { error: e.message };
          }
        }
        return json(res, 200, output);
      }
      /* 【歌单列表】完整读取平台分页，规范新旧歌单 ID，再把本地虚拟歌单追加到返回列表。 */
      if (action === 'GET /api/playlists') {
        const rows = await pages(s, 'user_playlist');
        const playlists = rows
          .map((x) => ({
            id: String(x.listid ?? x.list_id ?? x.global_collection_id ?? ''),
            listid: x.listid ?? x.list_id,
            globalId: x.global_collection_id,
            name: x.name ?? x.listname ?? '未命名歌单',
            count: Number(x.count ?? x.songcount ?? 0),
          }))
          .filter((x) => x.id);
        if (rows.length && !playlists.length) throw new Error('歌单标识格式尚未适配。');
        s.playlists = new Map(playlists.map((x) => [x.id, x]));
        const local = localPlaylist(s);
        return json(res, 200, { playlists: local ? [...playlists, local] : playlists });
      }
      /* 【歌单内容】先确认歌单属于本会话；按新旧 ID 选择平台接口，规范并登记每首歌曲。 */
      if (action === 'GET /api/tracks') {
        const id = u.searchParams.get('playlist');
        if (id === unauthorizedId && localPlaylist(s))
          return json(res, 200, {
            tracks: unauthorizedTracks(s),
            localPlaylist: localPlaylist(s),
          });
        if (!s.playlists.has(id))
          return json(res, 404, { error: '请先选择本账号的歌单' });
        const p = s.playlists.get(id);
        const { normalizeTrack } = await adapter('provider');
        const tracks = registerTracks(
          s,
          id,
          (
            await pages(
              s,
              p.listid !== undefined ? 'playlist_track_all_new' : 'playlist_track_all',
              p.listid !== undefined ? { listid: p.listid } : { id: p.globalId },
            )
          ).map(normalizeTrack),
        );
        return json(res, 200, { tracks });
      }
      // 检查摘要不生成票据，不上报历史；主动复查可跳过短期缓存。
      if (action === 'POST /api/inspect') {
        const track = s.tracks.get(u.searchParams.get('track'));
        if (!track) return json(res, 404, { error: '歌曲不属于当前会话' });
        const result = await inspect(s, track, u.searchParams.get('fresh') === '1', u.searchParams.get('accountFresh') === '1');
        return json(res, 200, { ...result, localPlaylist: recordAccess(s, track, result) });
      }
      /* 【权益/播放】都调用同一检查器；play 额外把完整音源换成同源 ticket，并保存此次权益结果。 */
      if (action === 'POST /api/check' || action === 'POST /api/play') {
        const track = s.tracks.get(u.searchParams.get('track'));
        if (!track) return json(res, 404, { error: '歌曲信息不完整，请刷新歌单' });
        const { checkAccess } = await adapter('access');
        const result = await checkAccess(s, track, action === 'POST /api/play');
        return json(res, 200, {
          ...(action === 'POST /api/play' ? mediaTickets(s, result) : result),
          localPlaylist: recordAccess(s, track, result),
        });
      }
      return json(res, 404, { error: '接口不存在' });
    } finally {
      s.busy = false;
    }
  } catch (e) {
    json(res, e instanceof HistoryError ? e.status : 502, { error: e instanceof Error ? e.message : '请求失败，请重试' });
  }
});
server.on('close', () => clearInterval(cleanup));
return server;
}
export const server = createMusicServer();
/* 直接执行此文件才启动默认端口；被测试导入时只导出 server，不占用真实播放器端口。 */
if (process.argv[1] === fileURLToPath(import.meta.url))
  server.listen(port, host, () => console.log(`音乐网页已启动：http://${host}:${port}`));
