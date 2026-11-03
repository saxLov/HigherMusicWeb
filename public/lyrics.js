/* LRC 解析与三行同步；共享 app.js 的播放状态。 */
/* renderLyricLine()：统一更新三行歌词，并识别以冒号分隔的创作署名。
 * 只匹配行首标签，不误伤正文中提到作曲家的句子；每次更新都切换 class，避免署名样式残留。
 * title 保留署名全文，鼠标悬停可查看被省略的名字；textContent 保证外部歌词按纯文本显示。 */
function renderLyricLine(id, text) {
  const element = $(id);
  const content = String(text || '');
  const credit = /^\s*(?:composed\s+by|composer|written\s+by|lyrics?\s+by|music\s+by|arranged\s+by|produced\s+by|作词|作曲|词曲|编曲|制作人|词|曲)\s*[:：]/i.test(content);
  element.textContent = content;
  element.classList.toggle('lyric-credit', credit);
  element.title = credit ? content : '';
}
/* resetLyrics()：清掉上一首的歌词行与 LRC 偏移，并设置当前提示文案，避免加载期间残留旧歌词。 */
function resetLyrics(message = '正在加载歌词…') {
  lyricLines = [];
  lyricIndex = -2;
  lrcOffset = 0;
  renderLyricLine('lyricCurrent', message);
  renderLyricLine('lyricBefore', '');
  renderLyricLine('lyricAfter', '');
}
/* parseLrc()：解析 LRC：支持一行多时间戳、按时间排序，并提取 [offset:毫秒] 转为秒。
 * 返回 {lines, offset}；无有效时间戳时 lines 为空，由上层显示暂无歌词。 */
function parseLrc(source) {
  const text = String(source || ''),
    header = text.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/im),
    lines = [];
  // LRC 正 offset 表示提前显示。它与用户微调叠加，毫秒只在这里换算一次。
  const offset =
    header && Number.isFinite(Number(header[1])) ? Number(header[1]) / 1000 : 0;
  for (const line of text.split(/\r?\n/)) {
    const tags = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)],
      content = line.replace(/\[[^\]]*\]/g, '').trim();
    if (content)
      for (const tag of tags)
        lines.push({ time: Number(tag[1]) * 60 + Number(tag[2]), text: content });
  }
  lines.sort((a, b) => a.time - b.time);
  return { lines, offset };
}
/* loadLyrics()：获取指定歌曲歌词并解析；只在 version 仍等于当前 playVersion 时更新，防止迟到歌词串歌。 */
async function loadLyrics(song, version) {
  resetLyrics();
  try {
    const d = await request('lyrics?track=' + encodeURIComponent(song.id));
    if (version !== playVersion) return;
    const parsed = parseLrc(d.lyrics);
    lyricLines = parsed.lines;
    lrcOffset = parsed.offset;
    if (!lyricLines.length) $('lyricCurrent').textContent = '暂无歌词';
    updateLyrics();
  } catch {
    if (version === playVersion) $('lyricCurrent').textContent = '歌词暂不可用';
  }
}
/* updateLyrics()：以音频当前时间 + 用户偏移 + LRC 偏移定位歌词。
 * 二分查找最后一个已到时的行，只在行号变化时更新“上一句/当前句/下一句”三行 DOM。 */
function updateLyrics() {
  if (!lyricLines.length) return;
  const now = audio.currentTime + lyricOffset + lrcOffset;
  // 二分查找兼容任意拖动进度；仅当当前句变化时更新 DOM。
  let low = 0,
    high = lyricLines.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (lyricLines[mid].time <= now) low = mid + 1;
    else high = mid;
  }
  const at = low - 1;
  if (at === lyricIndex) return;
  lyricIndex = at;
  renderLyricLine('lyricBefore', lyricLines[at - 1]?.text || '');
  renderLyricLine('lyricCurrent', lyricLines[at]?.text || '♪');
  renderLyricLine('lyricAfter', lyricLines[at + 1]?.text || '');
}
/* stopLyricSync()：取消待执行的逐帧歌词同步任务，并把句柄归零，允许下次重新启动。 */
function stopLyricSync() {
  if (lyricFrame) cancelAnimationFrame(lyricFrame);
  lyricFrame = 0;
}
/* lyricTick()：逐帧歌词循环；音频暂停、结束或页面隐藏时自然停止，减少后台消耗。 */
function lyricTick() {
  lyricFrame = 0;
  if (audio.paused || audio.ended || document.hidden) return;
  updateLyrics();
  lyricFrame = requestAnimationFrame(lyricTick);
}
/* startLyricSync()：启动唯一一个歌词逐帧循环；已启动或当前不播放时直接返回，避免重复排帧。 */
function startLyricSync() {
  if (lyricFrame || audio.paused || audio.ended || document.hidden) return;
  updateLyrics();
  lyricFrame = requestAnimationFrame(lyricTick);
}
/* updateOffsetLabel()：把当前歌词偏移显示为带正负号的一位小数秒，例如 -0.2s。 */
function updateOffsetLabel() {
  lyricOffsetOutput.textContent = `${lyricOffset >= 0 ? '+' : ''}${lyricOffset.toFixed(1)}s`;
}
/* adjustLyricOffset()：delta 是秒，每次按钮传入 ±0.1。四舍五入避免浮点误差，立即同步歌词并保存浏览器设置。 */
function adjustLyricOffset(delta) {
  lyricOffset = Math.round((lyricOffset + delta) * 10) / 10;
  updateOffsetLabel();
  updateLyrics();
  try {
    localStorage.setItem(LYRIC_OFFSET_KEY, String(lyricOffset));
  } catch {
    status('歌词偏移已调整，但浏览器不允许保存设置');
  }
}
