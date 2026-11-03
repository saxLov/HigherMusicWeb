/* 账号权益与音源检查的编排层。先查购买/会员，再查歌曲权益，最后核验平台返回音源。
 * 权益分类由 entitlements.mjs 完成，音源完整性由 rights.mjs 完成。
 * 所有缓存挂在当前 session，不在账号之间共享；play=true 时才附带供播放处理的地址。 */
import { call } from './provider.mjs';
import { collectPages } from './pagination.mjs';
import { classify } from './entitlements.mjs';
import { evaluatePlayback } from './rights.mjs';
/* createAccessChecker()：创建可注入 request 与时钟的检查器，便于单元测试；返回 checkAccess(s, track, play)。 */
export function createAccessChecker(request = call, now = Date.now) {
  /* account()：读取当前会话已购单曲、已购专辑和会员信息；正常缓存 120 秒，失败后仅缓存 10 秒以便重试。 */
  async function account(s, refresh = false) {
    const ttl = s.accountRights?.errors?.length ? 10000 : 120000;
    if (!refresh && s.accountRights && now() - s.accountRights.time < ttl) return s.accountRights;
    /* 保留权益与音源两个维度，前端可区分“已购但音源暂不可用”和“权益仍待核对”。 */
    const result = { songs: [], albums: [], vip: null, errors: [], time: now() };
    /* 分开查询单曲、专辑和会员；一项失败记在 errors，不把失败误当“用户没有购买”。 */
    for (const [key, name] of [
      ['songs', 'user_purchased_songs'],
      ['albums', 'user_purchased_albums'],
      ['vip', 'user_vip_detail'],
    ]) {
      try {
        result[key] =
          key === 'vip'
            ? (await request(s, name)).data
            : await collectPages(
                (page, pagesize) => request(s, name, { page, pagesize }),
                { pageSize: name === 'user_purchased_albums' ? 15 : 50 },
              );
        if (
          key === 'vip' &&
          (!result.vip || typeof result.vip !== 'object' || Array.isArray(result.vip))
        )
          throw new Error('会员数据格式尚未适配');
      } catch (e) {
        result.errors.push(`${key}: ${e.message}`);
      }
    }
    result.time = now();
    s.accountRights = result;
    return result;
  }
  /* checkAccess()：对单个歌曲版本组合账号权益与音源检查。play=false 返回资格摘要，true 额外返回播放候选地址。
   * refreshAccount 用于主动复查的首首歌曲，刷新账号缓存一次；其余歌曲复用 120 秒缓存。
   * 相关 128 音质只允许同专辑、同 MixSongID；最终候选标识回传，历史上报据此核对。 */
  return async function checkAccess(s, track, play = false, { refreshAccount = false } = {}) {
    const a = await account(s, refreshAccount);
    let resource;
    let detailError;
    try {
      const body = await request(s, 'privilege_lite', {
        hash: track.hash,
        album_id: track.albumId,
        album_audio_id: track.albumAudioId,
        qualities: '128',
      });
      const rows = Array.isArray(body.data) ? body.data : [];
      resource = rows.find(
        (x) => x && String(x.hash).toLowerCase() === String(track.hash).toLowerCase(),
      );
      if (!resource) detailError = '平台返回的权益记录未匹配到当前歌曲';
    } catch (e) {
      detailError = e.message;
    }
    // 同 hash 也不能借用另一专辑版本的权益或关联音源。
    const identityId = (value) =>
      value == null || ['', '0'].includes(String(value).trim()) ? '' : String(value).trim();
    const sameId = (left, right) =>
      !identityId(left) || !identityId(right) || identityId(left) === identityId(right);
    const inheritId = (value, fallback) => identityId(value) ? value : fallback;
    if (resource && (
      !sameId(track.albumAudioId, resource.album_audio_id) ||
      !sameId(track.albumId, resource.album_id)
    )) {
      detailError = '权益记录的专辑版本与当前歌曲不一致';
      resource = undefined;
    }
    const right = classify(track, resource, a);
    /* 先用歌单的原版本请求，必要时再试平台给出的普通 128 音质关联版本，缺少专辑标识时沿用原版本。 */
    const related = Array.isArray(resource?.relate_goods) ? resource.relate_goods : [];
    const candidates = [
      track,
      ...related
        .filter((x) => x && String(x.quality) === '128' &&
          sameId(track.albumAudioId, x.album_audio_id) && sameId(track.albumId, x.album_id))
        .map((x) => ({
          hash: x.hash,
          albumId: inheritId(x.album_id, inheritId(resource?.album_id, track.albumId)),
          albumAudioId:
            inheritId(x.album_audio_id, inheritId(resource?.album_audio_id, track.albumAudioId)),
        })),
    ];
    let media = { state: 'unknown', reason: detailError ?? '尚未取得可播放音源' };
    if (right.state !== 'unavailable') {
      const seen = new Set();
      for (const item of candidates) {
        const key = `${item.hash}:${item.albumId}:${item.albumAudioId}`;
        if (!item.hash || seen.has(key)) continue;
        seen.add(key);
        try {
          const b = await request(s, 'song_url', {
            hash: item.hash,
            album_id: item.albumId,
            album_audio_id: item.albumAudioId,
            quality: 128,
            free_part: false,
          });
          const source = b?.data ?? b;
          if ((source?.hash && String(source.hash).toLowerCase() !== String(item.hash).toLowerCase()) ||
              !sameId(item.albumAudioId, source?.album_audio_id)) {
            media = { state: 'unknown', reason: '音源响应的歌曲版本与请求不一致' };
            continue;
          }
          const candidate = evaluatePlayback(b, {
            duration: track.duration || resource?.info?.duration / 1000,
          });
          if (media.state !== 'allowed' && (candidate.canAttempt || !media.canAttempt))
            media = {
              ...candidate,
              identity: {
                hash: item.hash,
                albumId: item.albumId,
                albumAudioId: item.albumAudioId,
              },
            };
          if (media.state === 'allowed') break;
        } catch (e) {
          if (!media.canAttempt) media = { state: 'unknown', reason: e.message };
        }
      }
    }
    const result = {
      ...right,
      playbackState: media.state,
      playbackReason: media.reason,
      accountWarnings: a.errors,
    };
    // 完整音源只更新 playbackState，绝不提升账号权益或伪造购买/会员来源。
    /* 播放响应的 state 表示此次音源能否完整播放；原权益 state 另保存在 eligibilityState。 */
    if (play)
      return {
        ...result,
        eligibilityState: result.state,
        entitlementReason: result.reason,
        state:
          media.state === 'allowed' && right.state === 'allowed' && right.eligible === true
            ? 'allowed'
            : 'unknown',
        canAttempt: !!media.canAttempt && right.state === 'allowed' && right.eligible === true,
        playbackIdentity: media.identity,
        expectedDuration: media.expectedDuration,
        url: media.url,
        urls: media.urls,
        reason:
          media.state === 'allowed' ? result.reason : `${result.reason}；${media.reason}`,
      };
    return result;
  };
}
export const checkAccess = createAccessChecker();
