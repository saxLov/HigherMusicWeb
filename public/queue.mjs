/* 独立的播放队列模型，供模块调用和单元测试使用。只计算歌曲 ID，不直接操作 audio 或 DOM。
 * 注意：本模型的顺序模式到末尾返回 null；当前页面 app.js 的 advance() 则首尾循环。
 * 两处实现并不相互调用，修改页面切歌行为应优先查看 app.js。 */
export const playModes = ['sequence', 'single', 'shuffle'];

// Sequential playback stops at the end. Shuffle visits each eligible recording
// once per round; previous walks actual playback history.
export class PlaybackQueue {
  /* 创建独立队列；random 可注入固定随机函数以重现测试。默认 sequence 顺序模式。 */
  constructor(random = Math.random) {
    this.random = random;
    this.reset();
    this.mode = 'sequence';
  }
  /* 清空实际播放历史、历史游标和随机剩余池；切换歌单时应调用。 */
  reset() {
    this.history = [];
    this.position = -1;
    this.remaining = [];
  }
  /* 校验并切换 sequence/single/shuffle，清空旧随机池。 */
  setMode(mode) {
    if (!playModes.includes(mode)) throw new Error('未知播放模式');
    this.mode = mode;
    this.remaining = [];
  }
  /* 记录一次真正选中的歌曲；回退历史后再选新歌，会截掉旧的向前分支。 */
  select(id) {
    if (this.history[this.position] !== id) {
      this.history = this.history.slice(0, this.position + 1);
      this.history.push(id);
      this.position = this.history.length - 1;
    }
    this.remaining = this.remaining.filter((x) => x !== id);
  }
  /* 随机模式沿真实历史找仍有效的 ID；顺序/单曲模式返回前一项，到开头返回 null。 */
  previous(ids, current) {
    const allowed = new Set(ids);
    if (this.mode === 'shuffle') {
      while (this.position > 0) {
        const id = this.history[--this.position];
        if (allowed.has(id)) return id;
      }
      return null;
    }
    const index = ids.indexOf(current);
    return index > 0 ? ids[index - 1] : null;
  }
  /* 自然结束且单曲循环时返回当前 ID；随机模式优先走向前历史，再从不重复池抽签。
   * 此模块的顺序模式到尾返回 null，页面 app.js 的 advance() 另有循环策略。 */
  next(ids, current, { ended = false } = {}) {
    if (!ids.length) return null;
    if (ended && this.mode === 'single') return ids.includes(current) ? current : null;
    if (this.mode !== 'shuffle') {
      const index = ids.indexOf(current);
      return ids[index + 1] ?? null;
    }
    const allowed = new Set(ids);
    while (this.position < this.history.length - 1) {
      const id = this.history[++this.position];
      if (allowed.has(id)) return id;
    }
    this.remaining = this.remaining.filter((id) => allowed.has(id) && id !== current);
    if (!this.remaining.length) this.remaining = ids.filter((id) => id !== current);
    if (!this.remaining.length) return ids.includes(current) ? current : ids[0];
    const index = Math.floor(this.random() * this.remaining.length);
    return this.remaining.splice(index, 1)[0];
  }
}
