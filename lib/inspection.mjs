/* 只缓存短期检查摘要，不保存/返回平台音源，不签发音频票据。 */
export function createInspector(check, now = Date.now) {
  return async (s, track, fresh = false, refreshAccount = false) => {
    s.inspections ??= new Map();
    const previous = s.inspections.get(track.id);
    if (!fresh && !refreshAccount && previous && now() - previous.time < 30000) return previous.result;
    const raw = await check(s, track, true, { refreshAccount });
    const { url, urls, ...result } = raw;
    result.playable = result.state === 'allowed' && result.playbackState === 'allowed' &&
      [url, ...(urls || [])].some((value) => typeof value === 'string' && /^https:\/\//i.test(value));
    s.inspections.set(track.id, { time: now(), result });
    while (s.inspections.size > 2048) s.inspections.delete(s.inspections.keys().next().value);
    return result;
  };
}
