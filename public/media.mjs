/* 通用音频加载工具，供独立模块/测试使用。以 playing 事件而非 play() Promise 判断真正开始播放。
 * 当前 app.js 使用其内部的 loadSource()，还额外检查完整时长；修改本文件不会自动改动该内部函数。 */
/* loadAudio()：audio 为媒体元素，url 为候选地址，signal 用于取消，timeout 单位毫秒。
 * Promise 在 playing 时成功，error/取消/超时或自动播放拒绝时失败；所有路径都会解除本次事件监听。 */
export function loadAudio(audio, url, signal, timeout = 15000) {
  return new Promise((resolve, reject) => {
    let timer;
    const clean = () => {
      clearTimeout(timer);
      audio.removeEventListener('playing', success);
      audio.removeEventListener('error', fail);
      signal.removeEventListener('abort', abort);
    };
    const success = () => {
      clean();
      resolve();
    };
    const fail = () => {
      clean();
      reject(new Error('音源加载失败'));
    };
    const abort = () => {
      clean();
      reject(new DOMException('已切换歌曲', 'AbortError'));
    };
    if (signal.aborted) return abort();
    audio.addEventListener('playing', success);
    audio.addEventListener('error', fail);
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      clean();
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
