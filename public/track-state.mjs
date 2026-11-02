/* 歌曲的账号权益与实际音源状态模型，由后端 lib/library.mjs 使用。
 * eligible/entitlement 表示账号资格；playbackState 表示当次音源结果，两者不能混为一谈。 */
/* applyAccessResult()：将权益分类与音源结果分别写入歌曲对象。
 * 购买查询暂时失败时保留此前明确的已购资格，但当次音源状态仍更新，避免网络错误抹掉购买事实。 */
export function applyAccessResult(track, result) {
  const state = result.eligibilityState ?? result.state;
  // Transient account lookup errors are not evidence of a revoked purchase.
  const preservePurchase =
    track.entitlement === 'purchased' &&
    track.eligible &&
    state === 'unknown' &&
    result.accountWarnings?.length;
  if (!preservePurchase) {
    track.state = state;
    track.eligible = !!result.eligible;
    track.entitlement = result.entitlement;
    track.reason = result.entitlementReason ?? result.reason;
  }
  track.playbackState = result.playbackState;
  track.playbackReason = result.playbackReason;
  track.accountWarnings = result.accountWarnings;
}
/* 判定账号资格是否满足，不要求当次音源也成功；音源问题应另外读取 playbackState。 */
export const matchesAccount = (track) =>
  track.eligible === true && track.state !== 'unavailable';
