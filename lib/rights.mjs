/* 检查平台音源是否有完整性证据：排除试听、过滤地址、规范时长、与歌单参考时长比较。
 * 这一步只评估接口数据，浏览器播放时还会再次核验实际 audio.duration。 */
// A successful URL request alone cannot prove that the returned audio is complete.
/* evaluatePlayback()：规范主/备用音源并检查试听标识、时长；返回 allowed/blocked/unknown 及原因。
 * 时长比参考少超过 3 秒视为不完整；缺少证据保持 unknown，canAttempt 仅表示仍有浏览器验证条件。 */
export function evaluatePlayback(body, track) {
  const data = body?.data ?? body;
  const rawUrls = [data?.url, data?.backupUrl]
    .flat()
    .filter((x) => typeof x === 'string');
  // The platform also returns HTTP CDN links. Upgrade transport to HTTPS;
  // do not permit active schemes or fall back to unencrypted requests.
  const urls = [
    ...new Set(
      rawUrls
        .filter((x) => /^https?:\/\//i.test(x))
        .map((x) => x.replace(/^http:/i, 'https:')),
    ),
  ];
  const url = urls[0];
  if (data?.is_free_part == 1 || data?.isFreePart == 1 || data?.free_part == 1)
    return { state: 'blocked', reason: '仅允许试听' };
  if (!url) return { state: 'unknown', reason: '平台未返回可用音源，权限待确认' };
  const duration = Number(data.timeLength ?? data.timelength ?? data.duration);
  const seconds = duration > 10000 ? duration / 1000 : duration;
  const reference = Number(track?.duration);
  const hasSourceDuration = Number.isFinite(seconds) && seconds > 0;
  const hasReference = Number.isFinite(reference) && reference > 0;
  /* 优先用歌单时长作参考；歌单没有时长时才用音源时长，不因缺少歌单元数据直接拒播。 */
  const expectedDuration = hasReference ? reference : hasSourceDuration ? seconds : 0;
  if (!hasSourceDuration)
    return {
      state: 'unknown',
      reason: '音源时长缺失，等待实际音频校验',
      canAttempt: hasReference,
      expectedDuration,
      url,
      urls,
    };
  if (hasReference && seconds < reference - 3)
    return { state: 'blocked', reason: '返回音源短于完整歌曲，可能仅供试听' };
  // A missing playlist duration is missing metadata, not a denial of playback.
  return {
    state: 'allowed',
    reason: hasReference
      ? '音源检查通过，播放时验证实际加载'
      : '歌单时长缺失，将按音源时长校验播放',
    expectedDuration,
    canAttempt: true,
    url,
    urls,
  };
}
