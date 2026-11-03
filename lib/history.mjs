/* 独立历史上报：按酷狗账号限流，先预留轮次再请求，超时也不自动重发。 */
export class HistoryError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function readHistoryBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''))
    throw new HistoryError(415, '需要 JSON 请求');
  if (Number(req.headers['content-length']) > 2048)
    throw new HistoryError(413, '请求过大');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 2048) throw new HistoryError(413, '请求过大');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HistoryError(400, 'JSON 格式无效'); }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HistoryError(400, '请求格式无效');
  return value;
}

export function createHistoryReporter(call, now = Date.now) {
  const accounts = new Map();
  return async (s, body) => {
    if (!s.user || !s.jar?.userid || !s.jar?.token)
      throw new HistoryError(401, '请先扫码登录');
    const { songId, hash, playbackId } = body;
    if (typeof songId !== 'string' || songId.length > 256 ||
        typeof hash !== 'string' || !/^[a-f0-9]{32}$/i.test(hash) ||
        typeof playbackId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(playbackId))
      throw new HistoryError(400, '歌曲或播放轮次格式无效');
    const track = s.tracks.get(songId);
    if (!track || String(track.hash).toLowerCase() !== hash.toLowerCase())
      throw new HistoryError(404, '歌曲不属于当前会话');
    if (!track.checked || !track.eligible || track.state !== 'allowed' ||
        track.playbackState !== 'allowed')
      throw new HistoryError(403, '歌曲尚未通过完整播放检查');
    // 关联音源可以换文件 hash，但不能换专辑歌曲版本。
    const source = track.playbackIdentity;
    if (source && ((source.albumAudioId != null && String(source.albumAudioId) !== String(track.albumAudioId)) ||
        (source.albumId != null && String(source.albumId) !== String(track.albumId))))
      throw new HistoryError(403, '实际音源版本与历史记录不一致');
    const mxid = Number(track.albumAudioId);
    if (!Number.isSafeInteger(mxid) || mxid <= 0)
      return { ok: true, skipped: 'missing_platform_id' };
    const time = now();
    for (const [id, account] of accounts)
      if (!account.pending && time - account.touched > 4 * 3600000) accounts.delete(id);
    const key = String(s.jar.userid);
    let account = accounts.get(key);
    if (!account) {
      if (accounts.size >= 256) throw new HistoryError(429, '历史同步暂忙');
      account = { touched: time, last: -Infinity, events: new Map(), pending: false };
      accounts.set(key, account);
    }
    account.touched = time;
    for (const [id, event] of account.events)
      if (time - event.time > 4 * 3600000) account.events.delete(id);
    if (account.events.has(playbackId)) return { ok: true, skipped: 'duplicate' };
    if (account.pending || time - account.last < 10000)
      return { ok: true, skipped: 'throttled' };
    if (account.events.size >= 2048) return { ok: true, skipped: 'throttled' };
    account.last = time;
    account.pending = true;
    account.events.set(playbackId, { songId, time });
    try {
      // Cookie 由 provider.call 从当前会话附加；前端不能指定账号、时间或播放次数。
      const response = await call(s, 'playhistory_upload', { mxid });
      if (!response || Number(response.status) !== 1 || Number(response.error_code ?? 0) !== 0)
        throw new HistoryError(502, '平台未明确确认历史提交，本轮不重试');
      return { ok: true, accepted: true };
    } finally { account.pending = false; }
  };
}
