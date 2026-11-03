/* 页面与测试共用的媒体加载、播放队列。顺序模式首尾循环。 */
(function(root) {
const playModes = ['sequence', 'single', 'shuffle'];

// Sequential playback wraps at the end. Shuffle visits each eligible recording
// once per round; previous walks actual playback history.
class PlaybackQueue {
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
  /* 随机模式沿真实历史找仍有效的 ID；顺序/单曲模式首尾循环。 */
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
    return ids.length ? ids[(index - 1 + ids.length) % ids.length] : null;
  }
  /* 自然结束且单曲循环时返回当前 ID；随机模式优先走向前历史，再从不重复池抽签。
   * 顺序模式与页面保持一致，首尾循环。 */
  next(ids, current, { ended = false } = {}) {
    if (!ids.length) return null;
    if (ended && this.mode === 'single') return ids.includes(current) ? current : null;
    if (this.mode !== 'shuffle') {
      const index = ids.indexOf(current);
      return ids.length ? ids[(index + 1) % ids.length] : null;
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

function loadAudio(audio, url, signal, timeout = 15000, expected = 0) {
  return new Promise((resolve, reject) => {
    let timer;
    const clean = () => {
      clearTimeout(timer);
      audio.removeEventListener('playing', success);
      audio.removeEventListener('error', fail);
      audio.removeEventListener('loadedmetadata', metadata);
      signal.removeEventListener('abort', abort);
    };
    const validDuration = () => Number.isFinite(audio.duration) && audio.duration > 0 &&
      !(expected > 0 && audio.duration < expected - 3);
    const metadata = () => {
      if (!validDuration()) { clean(); audio.pause(); reject(new Error('音频不完整，已停止加载')); }
    };
    const success = () => {
      if (!validDuration()) return metadata();
      clean(); resolve();
    };
    const fail = () => {
      clean();
      audio.pause();
      reject(new Error('音源加载失败'));
    };
    const abort = () => {
      clean();
      reject(new DOMException('已切换歌曲', 'AbortError'));
    };
    if (signal.aborted) return abort();
    audio.addEventListener('playing', success);
    audio.addEventListener('error', fail);
    audio.addEventListener('loadedmetadata', metadata);
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      clean();
      audio.pause();
      reject(new Error('音源加载超时'));
    }, timeout);
    try {
      audio.src = url;
      Promise.resolve(audio.play()).catch((e) => {
        clean();
        reject(e);
      });
    } catch (e) {
      clean();
      reject(e);
    }
  });
}

root.HigherPlayer = { PlaybackQueue, playModes, loadAudio };
})(globalThis);
