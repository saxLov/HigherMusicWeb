// frames 是快闪帧数上限；近距离直接平移，中距离自动减少帧数。
const MONTAGE = Object.freeze({
  /* 【可调参数】快闪最多帧数；不是所有搜索都强制闪 18 次。 */
  frames: 18,
  /* 【可调参数】长距离单帧停留（毫秒）；中距离的独立速度在 montageTo 内。 */
  frameMs: 110,
  /* 【可调参数】最后一帧额外定格（毫秒）。 */
  holdMs: 220,
  /* 【可调参数】整层快闪淡出（毫秒），同步写入 CSS --montage-fade。 */
  fadeMs: 600,
  /* 【可调参数】开始前等待封面预加载的最长时间，图片慢也不会无限阻塞动画。 */
  preloadMs: 200,
});
/* 【蒙太奇动画函数】
 * 距离 0：播放当前曲；1–3：画廊平移；4–17：每首一帧；18 及以上：18 帧。
 * 按方向切片，排除当前曲、包含目标曲，再无放回地均匀抽样。
 * 短快闪每帧 150–180ms，长快闪保持 110ms；最后一帧只定格，不重复入队。
 */
/* montageTo()：搜索跳转的完整调度：先按绝对索引距离判断直接播放、近距离平移或快闪。
 * 路径切片排除起点并包含终点，最多 18 帧；保持方向且不重复抽样。
 * 动画期间锁定切歌，finally 无论成功/取消/异常都清理遮罩并解锁。 */
async function montageTo(target) {
  if (flashing || sliding || !Number.isInteger(target) ||
      target < 0 || target >= songs.length) return;

  const currentIndex = index;
  const distance = Math.abs(target - currentIndex);
  if (distance === 0) {
    playCurrent();
    return;
  }
  if (distance <= 3 || reducedMotion.matches) {
    goTo(target, !reducedMotion.matches);
    return;
  }

  // 例：2→6 取 [3,4,5,6]；6→2 取 [5,4,3,2]。
  const path = target > currentIndex
    ? songs.slice(currentIndex + 1, target + 1)
    : songs.slice(target, currentIndex).reverse();
  /* path.length 等于 distance。帧数不大于路径长度，均匀索引严格递增，因此不会重复采到同一路径位置。 */
  const frameCount = Math.min(distance, MONTAGE.frames);
  const frames = Array.from({ length: frameCount }, (_, n) =>
    path[Math.floor(n * (path.length - 1) / (frameCount - 1))],
  );
  /* 【快闪速度】距离 4–8 每帧 180ms，9–17 每帧 150ms，18 及以上取 MONTAGE.frameMs。 */
  const frameMs = distance >= MONTAGE.frames
    ? MONTAGE.frameMs
    : distance <= 8 ? 180 : 150;

  const version = viewVersion;
  clearTimeout(playTimer);
  playTimer = null;
  listening.reset();
  clearTimeout(recoveryTimer);
  flashing = true;
  audio.pause();
  resetLyrics();
  playVersion++;
  listening.reset();
  clearTimeout(recoveryTimer);
  playAbort?.abort();
  const layer = $('montage');
  const content = $('montageFrame');
  let frameAnimation;
  try {
    layer.hidden = false;
    layer.classList.remove('landing');
    layer.style.setProperty('--montage-fade', MONTAGE.fadeMs + 'ms');
    $('flashTitle').textContent = '';
    paintCover($('flashCover'), frames[0].cover);
    await Promise.race([
      Promise.all(frames.map((song) => preloadCover(song.cover).catch(() => {}))),
      wait(MONTAGE.preloadMs),
    ]);
    for (const song of frames) {
      if (version !== viewVersion) return;
      paintCover($('flashCover'), song.cover);
      $('flashTitle').textContent = song.title;
      frameAnimation?.cancel();
      frameAnimation = content.animate?.(
        [
          { opacity: 0.45, transform: 'scale(1.012)' },
          { opacity: 1, transform: 'scale(1)' },
        ],
        { duration: 100, easing: 'ease-out' },
      );
      await wait(frameMs);
    }
    if (version !== viewVersion) return;
    index = target;
    renderGallery();
    // 最后一帧已是目标曲，直接定格，避免重复设置目标帧。
    await wait(MONTAGE.holdMs);
    if (version !== viewVersion) return;
    layer.classList.add('landing');
    await wait(MONTAGE.fadeMs);
  } finally {
    frameAnimation?.cancel();
    layer.hidden = true;
    layer.classList.remove('landing');
    flashing = false;
  }
  if (version === viewVersion) playCurrent();
}
/* search()：打开当前可播放歌单内的搜索框；权限检查或快闪期间暂不接受搜索。 */
function search() {
  if (busy) return status('请等待权限检查完成，或先停止检查');
  if (!songs.length) return status('先选择歌单并检查完整音源');
  if (flashing || sliding) return;
  $('searchHint').textContent = '在当前已授权歌单中搜索 / Esc 关闭';
  $('searchDialog').showModal();
  $('searchInput').value = '';
  searchMatches = [];
  $('searchResults').replaceChildren();
  $('searchInput').focus();
}
/* 候选搜索：精确歌名在前，再按歌名/歌手匹配，保留所有版本。 */
function renderSearchResults() {
  const query = $('searchInput').value.trim().toLocaleLowerCase();
  const results = $('searchResults');
  results.replaceChildren();
  const matches = songs.map((song, at) => ({ song, at })).filter(({song}) =>
    query && `${song.title} ${song.artist}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => Number(b.song.title.toLocaleLowerCase() === query) - Number(a.song.title.toLocaleLowerCase() === query));
  searchMatches = matches;
  for (const { song, at } of matches.slice(0, 60)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${song.title} · ${song.artist} · ${at + 1}/${songs.length}`;
    button.onclick = () => { $('searchDialog').close(); montageTo(at).catch((e) => status(e.message)); };
    results.append(button);
  }
  $('searchHint').textContent = query ? (matches.length ? `${matches.length} 个结果，显示前 60 项；Tab 或方向键选择，回车播放` : '没有匹配的可播放歌曲') : '输入歌名或歌手 / Esc 关闭';
}
function bindSearch() {
  $('searchInput').oninput = renderSearchResults;
  $('searchForm').onsubmit = (e) => {
    e.preventDefault();
    if (!searchMatches.length) renderSearchResults();
    if (searchMatches.length) { const at = searchMatches[0].at; $('searchDialog').close(); montageTo(at).catch((e) => status(e.message)); }
  };
  $('searchDialog').addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    const buttons = [...$('searchResults').querySelectorAll('button')];
    if (!buttons.length) return;
    e.preventDefault();
    const current = buttons.indexOf(document.activeElement);
    const at = e.key === 'ArrowDown' ? (current + 1) % buttons.length : (current <= 0 ? buttons.length - 1 : current - 1);
    buttons[at].focus();
  });
}
