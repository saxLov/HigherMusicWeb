/* seconds 为实际收听秒数；媒体跳变不计时，用户拖动使本轮失效。
 * 正常换歌只清除当前轮次，已达标记录继续排队；退出/开关取消尚未发送的记录。 */
(function (root) {
  class ListeningTracker {
    constructor({ send, now = () => performance.now(), id = () => crypto.randomUUID() }) {
      this.send = send;
      this.now = now;
      this.id = id;
      this.enabled = true;
      this.generation = 0;
      this.round = null;
    }
    reset() {
      this.round = null;
    }
    /** 仅账号变化、退出或开关变化取消待提交任务；已发出的请求无法撤回。 */
    cancelPending() {
      this.generation++;
    }
    begin(song, audio) {
      this.round = {
        songId: song.id,
        hash: song.hash,
        playbackId: this.id(),
        seconds: 0,
        attempted: false,
        invalid: false,
        sample: null,
      };
      this.resume(audio);
    }
    sample(audio) {
      return {
        wall: this.now(),
        media: audio.currentTime,
        rate: audio.playbackRate || 1,
      };
    }
    resume(audio) {
      if (this.round) this.round.sample = this.sample(audio);
    }
    suspend() {
      if (this.round) this.round.sample = null;
    }
    seek() {
      if (this.round) {
        this.round.invalid = true;
        this.round.sample = null;
      }
    }
    setEnabled(value) {
      this.cancelPending();
      this.enabled = value;
      // 开关重新开启时从零计时，不补报关闭期间的播放。
      if (this.round) {
        this.round.seconds = 0;
        this.round.sample = null;
      }
    }
    tick(audio) {
      const round = this.round;
      if (!round || !this.enabled || round.invalid || round.attempted) return;
      if (audio.paused || audio.ended || audio.seeking || audio.readyState < 3) {
        this.suspend();
        return;
      }
      const next = this.sample(audio);
      const previous = round.sample;
      round.sample = next;
      if (!previous) return;
      const wall = (next.wall - previous.wall) / 1000;
      const delta = next.media - previous.media;
      if (next.rate !== previous.rate || wall <= 0 || wall > 5) return;
      if (delta < -0.05 || delta > wall * next.rate + Math.max(0.35, wall * next.rate * 0.2)) {
        this.seek();
        return;
      }
      round.seconds += Math.min(wall, Math.max(0, delta / next.rate));
      if (round.seconds > 15) {
        round.attempted = true; // 在异步发送前标记：失败也不自动重试本轮。
        const generation = this.generation;
        // 捕获原轮次，不依赖可能已经变成下一首的 this.round。
        const body = Object.freeze({
          songId: round.songId,
          hash: round.hash,
          playbackId: round.playbackId,
        });
        const valid = () => this.enabled && generation === this.generation && !round.invalid;
        Promise.resolve().then(() => {
          if (!valid()) return;
          return this.send(body, valid);
        }).catch((error) => {
          if (error.name !== 'AbortError') console.warn('听歌历史同步失败，本轮不自动重试。');
        });
      }
    }
  }
  root.HigherListening = { ListeningTracker };
})(globalThis);
