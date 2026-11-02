/* 已登录账号的诊断数据摘要。只返回字段结构、样本和错误，过滤凭证、用户标识及 URL。
 * 用来适配平台接口字段，不参与页面日常播放流程。 */
/* diagnostics()：依次查询账号购买/会员结构，并抽取最多 6 首已登记歌曲的权益样本；过滤敏感字段后返回诊断摘要。 */
export async function diagnostics(s, call) {
  /* 递归摘要：字符串仅保留长度，数组只展示首项形状，敏感字段整项过滤。 */
  const shape = (v, depth = 0) => {
    if (depth > 7) return '…';
    if (Array.isArray(v))
      return { length: v.length, sample: v.slice(0, 1).map((x) => shape(x, depth + 1)) };
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
  const examples = [...s.tracks.values()].slice(0, 6);
  for (const [i, t] of examples.entries()) {
    try {
      output['track' + i] = {
        title: t.title,
        privilege: shape(
          await call(s, 'privilege_lite', {
            hash: t.hash,
            album_id: t.albumId,
            qualities: '128',
            album_audio_id: t.albumAudioId,
          }),
        ),
      };
    } catch (e) {
      output['track' + i] = { error: e.message };
    }
  }
  return output;
}
