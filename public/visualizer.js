/* 沉浸模式的真实音频频谱。读取同一个 audio 元素，经 Web Audio 分析后绘制到 canvas。
 * 主输出只有一条：媒体源 → 扬声器；频谱分析是旁路，不能再次接扬声器。
 * 颜色、柱数和衰减速度在 draw() 附近调整；容器宽高由 style.css 控制。 */
/* 真实音频频谱：只建立一条音频图，频谱失败时保留直接输出通路。 */
(() => {
  const media = document.getElementById('audio'),
    canvas = document.getElementById('musicSpectrum');
  const context = canvas?.getContext?.('2d');
  if (!media || !context) return;
  /* engine=音频上下文，source=唯一媒体源，analyser=FFT 分析器，data=复用频率数组，frame=动画句柄。 */
  let engine,
    source,
    analyser,
    data,
    frame = 0,
    width = 1,
    height = 1;
  /* 【可调参数】48 根柱子；平滑后的振幅跨帧复用，避免每帧分配数组。 */
  const levels = new Float32Array(48);
  /* resize()：按画布的 CSS 实际尺寸重设像素尺寸；设备像素比最多取 2，兼顾清晰度与绘制成本。 */
  function resize() {
    const box = canvas.getBoundingClientRect(),
      ratio = Math.min(devicePixelRatio || 1, 2);
    width = Math.max(1, box.width);
    height = Math.max(1, box.height);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  /* clear()：清空当前画布，不销毁音频图或改变播放状态。 */
  function clear() {
    context.clearRect(0, 0, width, height);
  }
  /* stop()：取消频谱逐帧绘制，清零平滑数组并清空画布；暂停/结束/离开沉浸模式时调用。 */
  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
    levels.fill(0);
    clear();
  }
  /* draw()：读取 FFT 频率数据，将 45–6000Hz 对数划分为 48 根柱子；上升快、衰减慢。
   * 只有播放中、页面可见且处于沉浸模式才继续排下一帧，静音时不制造假跳动。 */
  function draw() {
    frame = 0;
    if (
      media.paused ||
      media.ended ||
      document.hidden ||
      !document.body.classList.contains('immersive')
    ) {
      clear();
      return;
    }
    analyser.getByteFrequencyData(data);
    clear();
    const binHz = engine.sampleRate / analyser.fftSize,
      step = width / levels.length;
    for (let i = 0; i < levels.length; i++) {
      // 对数频带，保留 45–250Hz 的低频细节；没有声音就不产生跳动。
      const from = Math.max(
        1,
        Math.floor((45 * Math.pow(6000 / 45, i / levels.length)) / binHz),
      );
      const to = Math.min(
        data.length - 1,
        Math.ceil((45 * Math.pow(6000 / 45, (i + 1) / levels.length)) / binHz),
      );
      let sum = 0;
      for (let n = from; n <= to; n++) sum += data[n];
      const value = to >= from ? sum / ((to - from + 1) * 255) : 0;
      /* 【可调参数】0.6 为上升响应，0.18 为下降响应；越大越跟手，越小越平滑。 */
      levels[i] += (value - levels[i]) * (value > levels[i] ? 0.6 : 0.18);
      const bar = Math.pow(levels[i], 1.3) * (height - 2);
      if (bar < 0.4) continue;
      /* 【可调参数】频谱颜色和不透明度；0.48 控制柱宽相对间距的比例。 */
      context.fillStyle = 'rgba(245,244,242,.65)';
      context.fillRect(i * step, height - bar, Math.max(1, step * 0.48), bar);
    }
    frame = requestAnimationFrame(draw);
  }
  /* start()：存在分析器且正在播放时启动唯一绘制循环，先同步画布尺寸。 */
  function start() {
    if (!analyser || frame || media.paused) return;
    resize();
    frame = requestAnimationFrame(draw);
  }
  /* enable()：首次用户手势时建立 AudioContext 与媒体源，之后只恢复/复用，避免为同一 audio 重复创建源。
   * 分析旁路失败时保留 source → destination 的主音频通路。 */
  async function enable() {
    const Engine = window.AudioContext || window.webkitAudioContext;
    if (!Engine) return;
    try {
      if (!engine) {
        engine = new Engine();
        const meter = engine.createAnalyser();
        /* 【可调参数】FFT 样本数为 2048，决定频率分辨率；smoothingTimeConstant 另作频域平滑。 */
        meter.fftSize = 2048;
        meter.smoothingTimeConstant = 0.7;
        source = engine.createMediaElementSource(media);
        source.connect(engine.destination);
        // 分析支路不连接扬声器，避免叠加音量；分析失败不拆掉主输出通路。
        try {
          source.connect(meter);
          analyser = meter;
          data = new Uint8Array(meter.frequencyBinCount);
        } catch {
          analyser = null;
        }
      }
      if (engine.state === 'suspended') await engine.resume();
      start();
    } catch {
      if (source)
        try {
          source.connect(engine.destination);
        } catch {}
    }
  }
  // 用户手势内恢复 AudioContext；同源 /api/audio 避免跨域媒体分析静音。
  document.addEventListener('pointerdown', enable, { passive: true });
  document.addEventListener('keydown', enable);
  media.addEventListener('playing', enable);
  media.addEventListener('pause', stop);
  media.addEventListener('ended', stop);
  media.addEventListener('emptied', stop);
  /* 监听 body.immersive 的变化，切入时绘制、切出时停止；不影响音频播放。 */
  new MutationObserver(() => {
    if (document.body.classList.contains('immersive')) start();
    else stop();
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else start();
  });
  if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
  else window.addEventListener('resize', resize);
  resize();
})();
