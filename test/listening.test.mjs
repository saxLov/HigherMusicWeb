import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../public/listening.js';
const { ListeningTracker } = globalThis.HigherListening;
const flush = () => new Promise(setImmediate);
function fixture() {
  let wall = 0, sequence = 0;
  const sent = [], audio = { currentTime: 0, playbackRate: 1, readyState: 4, paused: false, ended: false, seeking: false };
  const tracker = new ListeningTracker({ send: (body) => sent.push(body), now: () => wall, id: () => String(++sequence) });
  const song = { id: 'a:hash', hash: 'a'.repeat(32) };
  tracker.begin(song, audio);
  const step = (seconds = 1, media = seconds * audio.playbackRate) => {
    wall += seconds * 1000; audio.currentTime += media; tracker.tick(audio);
  };
  return { tracker, sent, audio, song, step };
}
test('真实听满15秒仍不报，超过后只发一次；单曲新轮次重新累计', async () => {
  const f = fixture();
  for (let n = 0; n < 15; n++) f.step();
  await flush(); assert.equal(f.sent.length, 0);
  for (let n = 0; n < 20; n++) f.step();
  await flush(); assert.equal(f.sent.length, 1);
  f.audio.currentTime = 0; f.tracker.begin(f.song, f.audio);
  for (let n = 0; n < 16; n++) f.step();
  await flush(); assert.equal(f.sent.length, 2);
  assert.notEqual(f.sent[0].playbackId, f.sent[1].playbackId);
});
test('拖到一分钟或回拖，本轮永久取消资格；快速换歌不补报旧轮次', async () => {
  const f = fixture(); f.step(); f.tracker.seek(); f.audio.currentTime = 60;
  f.tracker.resume(f.audio);
  for (let n = 0; n < 20; n++) f.step();
  await flush(); assert.equal(f.sent.length, 0);
  f.tracker.begin(f.song, f.audio);
  for (let n = 0; n < 14; n++) f.step();
  f.tracker.reset();
  f.step(2); await flush(); assert.equal(f.sent.length, 0);
});
test('未派发seeking的进度跳变也不能上报', async () => {
  const f = fixture(); f.step(1, 60);
  for (let n = 0; n < 20; n++) f.step();
  await flush(); assert.equal(f.sent.length, 0);
});
test('暂停和缓冲不累计；恢复后继续真实时长', async () => {
  const f = fixture();
  for (let n = 0; n < 8; n++) f.step();
  f.audio.paused = true; f.tracker.suspend(); f.step(100, 0);
  f.audio.paused = false; f.tracker.resume(f.audio);
  f.audio.readyState = 2; f.step(100, 0);
  f.audio.readyState = 4; f.tracker.resume(f.audio);
  for (let n = 0; n < 7; n++) f.step();
  await flush(); assert.equal(f.sent.length, 0);
  f.step(); await flush(); assert.equal(f.sent.length, 1);
});
test('倍速按实际收听秒数，长时间缺失timeupdate保守跳过', async () => {
  const f = fixture(); f.audio.playbackRate = 2; f.tracker.resume(f.audio);
  for (let n = 0; n < 8; n++) f.step();
  await flush(); assert.equal(f.sent.length, 0);
  f.step(60, 120);
  await flush(); assert.equal(f.sent.length, 0);
  for (let n = 0; n < 8; n++) f.step();
  await flush(); assert.equal(f.sent.length, 1);
});
test('关闭后不报，开启从零累计；关闭再开启也撤销未发送微任务', async () => {
  const f = fixture();
  for (let n = 0; n < 16; n++) f.step();
  f.tracker.setEnabled(false); f.tracker.setEnabled(true);
  await flush(); assert.equal(f.sent.length, 0);
  f.tracker.begin(f.song, f.audio); f.tracker.setEnabled(false);
  for (let n = 0; n < 20; n++) f.step();
  f.tracker.setEnabled(true); f.tracker.resume(f.audio);
  for (let n = 0; n < 15; n++) f.step();
  await flush(); assert.equal(f.sent.length, 0);
  f.step(); await flush(); assert.equal(f.sent.length, 1);
});
test('提交失败仅警告，本轮不自动重复', async () => {
  const f = fixture(); let calls = 0, warnings = 0;
  f.tracker.send = async () => { calls++; throw new Error('failure'); };
  const warn = console.warn; console.warn = () => warnings++;
  try {
    for (let n = 0; n < 40; n++) f.step();
    await flush(); f.step(); await flush();
    assert.equal(calls, 1); assert.equal(warnings, 1);
  } finally { console.warn = warn; }
});
test('已达标的记录在同一事件循环中切歌后仍提交原歌曲，未达标仍丢弃', async () => {
  const f = fixture();
  for (let n = 0; n < 16; n++) f.step();
  f.tracker.reset();
  f.tracker.begin({ id: 'b', hash: 'b'.repeat(32) }, f.audio);
  await flush();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].songId, f.song.id);
});

test('达标后尚未出队时关闭开关、退出账号或拖动均取消提交资格', async () => {
  for (const cancel of [(t) => t.setEnabled(false), (t) => t.cancelPending(), (t) => t.seek()]) {
    const f = fixture();
    for (let n = 0; n < 16; n++) f.step();
    cancel(f.tracker);
    await flush();
    assert.equal(f.sent.length, 0);
  }
});
