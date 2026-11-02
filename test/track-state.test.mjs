/* 自动检查：歌曲状态模型：购买权益与播放失败分离，临时错误不抹除已购事实。
 * 使用 Node 内置 node:test 与 assert；每个中文 test 标题说明场景，assert 是预期结果。
 * 桩数据用于可重复的本地验证，不代表平台当次真实权益；运行 node --test test/*.test.mjs。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAccessResult, matchesAccount } from '../public/track-state.mjs';

test('已购权益与音源加载失败分开保留，筛选仍能找到已购歌曲', () => {
  const track = {};
  applyAccessResult(track, {
    state: 'unknown',
    eligibilityState: 'allowed',
    eligible: true,
    entitlement: 'purchased',
    entitlementReason: '已购',
    playbackState: 'unknown',
  });
  assert.equal(matchesAccount(track), true);
  assert.equal(track.reason, '已购');
  assert.equal(track.playbackState, 'unknown');
});
test('购买查询暂时失败不能抹去此前明确的购买记录', () => {
  const track = {
    state: 'allowed',
    eligible: true,
    entitlement: 'purchased',
    reason: '已购',
  };
  applyAccessResult(track, {
    state: 'unknown',
    eligible: false,
    accountWarnings: ['songs: temporary'],
    playbackState: 'unknown',
  });
  assert.equal(matchesAccount(track), true);
  assert.equal(track.entitlement, 'purchased');
});
test('会员到期后不能保留上次会员入选状态', () => {
  const track = { state: 'allowed', eligible: true, entitlement: 'vip' };
  applyAccessResult(track, { state: 'unknown', eligible: false, entitlement: 'unknown' });
  assert.equal(matchesAccount(track), false);
});
test('平台明确未上架后排除已购歌曲', () => {
  const track = { state: 'allowed', eligible: true, entitlement: 'purchased' };
  applyAccessResult(track, {
    state: 'unavailable',
    eligible: false,
    entitlement: 'catalogue',
  });
  assert.equal(matchesAccount(track), false);
});
