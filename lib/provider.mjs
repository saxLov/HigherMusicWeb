/* 酷狗连接组件适配层。按需加载 .runtime 内的固定版本组件，统一 Cookie、超时和错误脱敏。
 * 负责把平台不同字段形状规范成项目字段；不决定某首歌是否有完整播放权限。 */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { coverUrl } from './gallery.mjs';
const require = createRequire(import.meta.url);
let api;
/* ready()：按需 require 本地酷狗连接组件并缓存；缺失或加载失败返回 false，页面据此提示安装。 */
export function ready() {
  try {
    api ??= require('../.runtime/source/KuGouMusicApi-main/main.js');
    return true;
  } catch {
    return false;
  }
}
/* call()：调用组件 name 接口，自动合并会话 Cookie 和设备标识，最长等待 20 秒。
 * 吸收返回 Cookie，检查平台状态；错误返回前去除凭证与签名 URL。 */
export async function call(session, name, params = {}) {
  if (!ready()) throw new Error('酷狗连接组件尚未安装，请按 README 完成安装。');
  /* 每个会话单独生成平台所需设备字段，仅在会话内复用，不借用另一个账号的身份。 */
  if (!session.jar.KUGOU_API_GUID) {
    const util = require('../.runtime/source/KuGouMusicApi-main/util/util.js');
    const guid = randomBytes(16).toString('hex');
    Object.assign(session.jar, {
      KUGOU_API_GUID: guid,
      KUGOU_API_MID: util.calculateMid(guid),
      KUGOU_API_DEV: randomBytes(16).toString('hex').toUpperCase(),
      KUGOU_API_MAC: '02:00:00:00:00:00',
      KUGOU_API_WEBGL: util.generateWebGLHash(),
    });
  }
  const fn = api[name];
  if (!fn) throw new Error('连接组件缺少所需接口。');
  let timer;
  try {
    const result = await Promise.race([
      fn({ ...params, cookie: { ...session.jar } }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('平台响应超时，请稍后重试。')), 20000);
      }),
    ]);
    for (const cookie of result.cookie ?? []) {
      const pair = cookie.split(';')[0];
      const at = pair.indexOf('=');
      if (at > 0) session.jar[pair.slice(0, at)] = pair.slice(at + 1);
    }
    const body = result.body;
    if (!body || (body.error_code && Number(body.error_code) !== 0) || body.status === 0)
      throw new Error('平台暂未接受请求，请重试或重新登录。');
    return body;
  } catch (error) {
    // Never expose upstream errors: they may contain account tokens or signed URLs.
    if (error instanceof Error && /^(平台|酷狗|连接组件)/.test(error.message))
      throw error;
    const status = Number(error?.status ?? error?.response?.status) || 0;
    const code =
      Number(error?.body?.error_code ?? error?.response?.data?.error_code) || 0;
    const upstream =
      error?.body?.error ??
      error?.body?.errmsg ??
      error?.body?.error_msg ??
      error?.body?.message ??
      error?.body?.msg;
    let hint = typeof upstream === 'string' ? upstream : '';
    for (const secret of Object.values(session.jar))
      if (String(secret).length > 8) hint = hint.split(String(secret)).join('[redacted]');
    hint = hint
      .replace(/https?:\/\/\S+/g, '[url]')
      .replace(/[A-Za-z0-9_=-]{24,}/g, '[redacted]')
      .slice(0, 120);
    throw new Error(
      `酷狗连接失败（HTTP ${status || '未知'}，错误码 ${code}${hint ? '，' + hint : ''}），请稍后重试。`,
    );
  } finally {
    clearTimeout(timer);
  }
}
/* listFrom()：从平台多个已知字段中找数组；合法空数组可返回，未知结构抛错，避免悄悄漏数据。 */
export function listFrom(body) {
  const d = body?.data;
  for (const x of [
    d?.info,
    d?.list,
    d?.songs,
    d?.goods,
    d?.goods_list,
    d?.file,
    d?.files,
    d?.data,
    d?.songs?.list,
    body?.info,
    body?.list,
    d,
  ])
    if (Array.isArray(x)) return x;
  throw new Error('平台返回的数据格式尚未适配，请稍后重试。');
}
/* normalizeTrack()：把平台原始记录转换为统一歌曲模型；合并 fileinfo，规范封面 URL 和秒单位时长，初始状态为未检查。 */
export function normalizeTrack(x) {
  x = { ...x, ...x.fileinfo };
  const duration = Number(x.duration ?? x.timelen ?? x.time_length ?? 0);
  return {
    id: String(x.album_audio_id || x.audio_id || x.hash || x.filehash || ''),
    hash: x.hash ?? x.filehash,
    albumId: x.album_id ?? x.albumid,
    albumAudioId: x.album_audio_id ?? x.mixsongid,
    audioId: x.audio_id,
    title: x.name ?? x.filename ?? x.songname ?? x.audio_name ?? '未命名歌曲',
    artist: x.singername ?? x.author_name ?? '',
    cover: coverUrl(x.sizable_cover, x.cover, x.album_img, x.img),
    duration: duration > 10000 ? duration / 1000 : duration,
    state: 'unchecked',
    reason: '尚未检查',
  };
}
