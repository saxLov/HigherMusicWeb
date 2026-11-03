/* 仅判断账号对特定歌曲版本的权益，输出 state、eligible、entitlement、reason。
 * 已购/会员/免费是权益来源，不能仅凭一个音频 URL 推断；同名歌曲的不同版本必须按标识匹配。 */
/* 统一有效 ID：排除 null/undefined/空白/0，避免缺失值之间互相命中。 */
const id = (v) =>
  v !== undefined && v !== null && String(v).trim() !== '' && String(v).trim() !== '0'
    ? String(v).trim()
    : '';
/* purchaseKey()：规范购买记录的版本、单曲、专辑标识及 hash；空串和 0 都不作为有效标识。 */
export function purchaseKey(record) {
  if (!record || typeof record !== 'object') record = {};
  return {
    audioId: id(record.album_audio_id),
    songId: id(record.audio_id),
    albumId: id(record.album_id),
    hash: typeof record.hash === 'string' ? record.hash.toLowerCase() : '',
  };
}
/* matchPurchase()：优先比较 album_audio_id，其次 audio_id，最后 hash；不按歌曲名字匹配，避免同名不同版误判。 */
export function matchPurchase(track, purchases) {
  const t = purchaseKey(track);
  return purchases.find((p) => {
    const r = purchaseKey(p);
    if (t.audioId && r.audioId) return t.audioId === r.audioId;
    // An album audio ID represents the specific recording in an album.
    // Different editions with the same name must never match by title.
    if (t.songId && r.songId) return t.songId === r.songId;
    return !!t.hash && !!r.hash && t.hash === r.hash;
  });
}
/* classify()：只接受版本匹配的购买证据，或普通音质明确免费的证据。
 * status=1 仅说明资源状态；is_vip=1 仅说明账号会员状态，二者不能证明某一付费版本被会员覆盖。
 * 参数 account 含 songs/albums/vip/errors；购买查询失败只能判待确认，不能断言未购买。 */
export function classify(track, resource, account) {
  const canonical = {
    album_audio_id: id(track.albumAudioId) || resource?.album_audio_id,
    audio_id: id(track.audioId) || resource?.id,
    hash: track.hash ?? resource?.hash,
  };
  const bought = matchPurchase(canonical, account.songs ?? []);
  const album = (account.albums ?? []).find(
    (x) =>
      x && id(x.album_id) && id(x.album_id) === (id(track.albumId) || id(resource?.album_id)),
  );
  const items = [
    resource,
    ...(Array.isArray(resource?.relate_goods) ? resource.relate_goods : []),
  ].filter((x) => x && String(x.quality) === '128');
  const available = items.find((x) => Number(x.status) === 1);
  // Publish=0 is a catalogue restriction, not a request failure or VIP restriction.
  if (
    resource &&
    [resource.publish, resource.is_publish].some(
      (x) => x !== null && x !== undefined && String(x) === '0',
    )
  )
    return {
      state: 'unavailable',
      reason: '平台标记该版本未上架',
      entitlement: 'catalogue',
      eligible: false,
    };
  if (bought || album)
    return {
      state: 'allowed',
      reason: album ? '已购专辑覆盖此歌曲' : '已购单曲记录匹配',
      entitlement: 'purchased',
      eligible: true,
    };
  const explicitZero = (value) =>
    typeof value === 'number' ? value === 0 :
      typeof value === 'string' && /^0(?:\.0+)?$/.test(value.trim());
  if (
    available &&
    explicitZero(available.privilege) &&
    explicitZero(available.pay_type) &&
    explicitZero(available.price)
  )
    return {
      state: 'allowed',
      reason: '平台确认普通音质免费',
      entitlement: 'free',
      eligible: true,
    };
  // A failed purchase lookup cannot establish that the user has not bought a song.
  return {
    state: 'unknown',
    reason: account.errors?.length
      ? '购买记录读取失败，权益待核对'
      : Number(account.vip?.is_vip) === 1
        ? '会员有效，但当前版本的会员覆盖范围待确认'
        : '平台未确认此版本的账号权限',
    entitlement: 'unknown',
    eligible: false,
  };
}
