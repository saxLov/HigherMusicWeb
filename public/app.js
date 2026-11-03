/* 前端交互总入口，由 index.html 以 defer 加载，直接使用页面现有 DOM。
 * 负责会话恢复、扫码登录、歌单检查、九卡片画廊、音频、歌词、背景、搜索与快捷键。
 * 界面外观和字号请改 style.css；本文件负责行为，不负责文字的 CSS 大小。
 * 后端接口统一走 request() 串行队列；图片预加载和 audio 播放独立进行。
 * 阅读顺序：状态变量 → 请求/清洗 → 封面/画廊 → 播放 → 歌词 → 背景 → 搜索快闪 → 事件绑定。 */
// 唯一后端基地址。请通过此后端的 HTTP 地址访问页面，勿双击 file:// 打开。
const API_BASE = ''; // 同源路径，无需修改域名或端口
// 单位：秒；按要求以 audio.currentTime + lyricOffset 比对，正数提前，负数延后。
/* 【可调参数】默认歌词偏移（秒）：负值延后、正值提前；浏览器已保存值优先于这里。 */
let lyricOffset = -0.2;
const LYRIC_OFFSET_KEY = 'higherweb.lyricOffset.v1';
try {
  const saved = localStorage.getItem(LYRIC_OFFSET_KEY);
  if (saved !== null && saved.trim() !== '' && Number.isFinite(Number(saved)))
    lyricOffset = Math.round(Number(saved) * 10) / 10;
} catch {}
/* 【DOM 工具】$ 按 id 查元素；audio 是唯一播放器，cards 保存九张卡片的当前逻辑排列。 */
const $ = (id) => document.getElementById(id);
const audio = $('audio'),
  cards = [...document.querySelectorAll('.card')];
// 直接插入现有底栏，无需改动页面架构或增加外部组件。
const lyricAdjust = document.createElement('div');
lyricAdjust.className = 'lyric-adjust';
lyricAdjust.setAttribute('role', 'group');
lyricAdjust.setAttribute('aria-label', '歌词时间微调');
const lyricLabel = document.createElement('span');
lyricLabel.textContent = '歌词';
const lyricMinus = document.createElement('button');
lyricMinus.textContent = '−';
lyricMinus.setAttribute('aria-label', '歌词延后 0.1 秒');
lyricMinus.title = '歌词延后 0.1 秒';
const lyricOffsetOutput = document.createElement('output');
lyricOffsetOutput.setAttribute('aria-label', '歌词偏移秒数');
const lyricPlus = document.createElement('button');
lyricPlus.textContent = '+';
lyricPlus.setAttribute('aria-label', '歌词提前 0.1 秒');
lyricPlus.title = '歌词提前 0.1 秒';
lyricAdjust.append(lyricLabel, lyricMinus, lyricOffsetOutput, lyricPlus);
$('status').before(lyricAdjust);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
/* 【封面占位】内嵌 SVG，无网络封面时显示；这是占位图，不是自定义全屏背景。 */
const FALLBACK =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"><rect width="500" height="500" fill="#242525"/><circle cx="250" cy="250" r="145" fill="none" stroke="#555650"/><circle cx="250" cy="250" r="70" fill="none" stroke="#555650"/><text x="250" y="270" text-anchor="middle" fill="#97988f" font-size="50">♪</text></svg>',
  );
/* 【歌曲与版本状态】songs=可播放曲；rawTracks=原歌单；rejected=本次未入选。
 * index=当前曲；loadedId=已加载曲；view/play/loginVersion 分别隔离歌单、播放和扫码的迟到结果。 */
let songs = [],
  rawTracks = [],
  rejected = [],
  index = 0,
  loadedId = '',
  viewVersion = 0,
  playVersion = 0,
  loginVersion = 0;
/* 【界面状态】busy=权限检查中；flashing=快闪中；loadingAudio=音频加载中。
 * sliding 当前预留为动画守卫；stopCheck 请求在当前检查结束后停止；bgVersion 隔离背景异步解码。 */
let busy = false,
  sliding = false,
  flashing = false,
  loadingAudio = false,
  stopCheck = false,
  backgroundSide = 0,
  bgVersion = 0;
/* 【异步任务】API 队列在 api-client.js 中；playTimer 合并快速切歌；playAbort 取消旧媒体加载。
 * wheelSum/wheelAt 累计滚轮距离与间隔；pollTimer 管扫码轮询。 */
let pollTimer,
  wheelSum = 0,
  wheelAt = 0,
  playAbort;
/* 【歌词与随机历史】lyricLines=按时间排序的歌词；lyricIndex=-2 表示尚未渲染。
 * playbackQueue 统一维护成功播放历史与随机候选池。 */
let lyricLines = [],
  lyricIndex = -2,
  playlistRows = [];
/* lrcOffset 为 LRC 文件头偏移（秒）；lyricFrame 为逐帧回调句柄；playTimer 为延迟播放句柄。 */
let lrcOffset = 0,
  lyricFrame = 0,
  playTimer;
const playbackQueue = new HigherPlayer.PlaybackQueue();
const checkedIds = new Set();
let recoveryTimer, recoverySong = '', recoveryAttempts = 0;
// 仅用于服务端换源后的自动定位；用户拖动始终使本轮失效。
let automaticSeek = null;
const SYNC_KEY = 'higherweb.historySync.v1';
const listening = new HigherListening.ListeningTracker({
  send: (body, valid = () => true) => {
    const generation = listening.generation;
    return request(
      'report_history',
      'POST',
      () => listening.enabled && generation === listening.generation && valid(),
      { body, priority: 5 },
    );
  },
});
try { listening.setEnabled(localStorage.getItem(SYNC_KEY) !== 'false'); } catch {}
$('historySync').checked = listening.enabled;
$('historySync').onchange = () => {
  listening.setEnabled($('historySync').checked);
  if (listening.enabled && !audio.paused) listening.resume(audio);
  try { localStorage.setItem(SYNC_KEY, String(listening.enabled)); }
  catch { console.warn('听歌历史同步设置无法保存。'); }
};
document.defaultView?.addEventListener('storage', (event) => {
  if (event.key !== SYNC_KEY) return;
  listening.setEnabled(event.newValue !== 'false');
  $('historySync').checked = listening.enabled;
  if (listening.enabled && !audio.paused) listening.resume(audio);
});
function accessSummary(result) {
  return { state: result.eligibilityState ?? result.state, eligible: result.eligible,
    entitlement: result.entitlement, entitlementReason: result.entitlementReason ?? result.reason,
    reason: result.entitlementReason ?? result.reason, playbackState: result.playbackState,
    playbackReason: result.playbackReason };
}
function accessCategory(track) {
  if (track.category) return track.category;
  if (track.state === 'unavailable') return 'catalogue';
  if (/试听/.test(track.playbackReason || '')) return 'preview';
  if (track.eligible) return 'source';
  return 'rights';
}
/* 底栏提示、毫秒等待、秒转“分:秒”和网络图片 URL 规范化的轻量工具。 */
const status = (text) => ($('status').textContent = text);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const time = (n) =>
  Number.isFinite(n)
    ? `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`
    : '0:00';
const https = (value) =>
  typeof value === 'string' && /^https?:\/\//i.test(value)
    ? value.replace(/^http:/i, 'https:').replaceAll('{size}', '500')
    : '';

// 所有 fetch 都通过 API_BASE；串行请求避免现有后端的会话 busy 限制。
/* request()：统一调用 /api/。route 不带 /api/ 前缀；method 默认 GET；valid 在真正出队时校验任务是否仍有效。
 * 队列按优先级串行处理；出队前校验任务，失败不会阻断后续请求。 */
const request = HigherApi.createApiClient(API_BASE);
// 【数据清洗】四个统一展示字段 + 仅供业务使用的稳定 ID、时长等元数据。
/* cleanTrack()：将歌单 raw 与当次播放 result 合并成统一歌曲对象。
 * 拆分“歌手 - 歌名”、去扩展名、规范封面和音源；id 用于背景绑定与切歌校验，duration 的单位是秒。 */
function cleanTrack(raw, result = {}) {
  let title = String(raw.title || raw.name || raw.filename || '未命名歌曲')
    .replace(/\.(mp3|flac|wav|ogg)$/i, '')
    .trim();
  let artist = String(raw.artist || raw.singername || '').trim();
  if (!artist && title.includes(' - ')) {
    const parts = title.split(' - ');
    artist = parts.shift();
    title = parts.join(' - ');
  }
  const mediaUrl = (value) =>
    typeof value === 'string' && /^\/api\/audio\?ticket=[a-f0-9]{48}$/.test(value)
      ? value
      : https(value);
  const urls = [result.url, ...(Array.isArray(result.urls) ? result.urls : []), raw.audio]
    .map(mediaUrl)
    .filter(Boolean);
  return {
    title,
    artist: artist || '未知歌手',
    audio: urls[0] || '',
    cover: https(result.cover || raw.cover || raw.sizable_cover),
    id: String(raw.id || raw.albumAudioId || raw.hash || ''),
    hash: String(raw.hash || ''),
    urls: [...new Set(urls)],
    duration: Number(result.expectedDuration || raw.duration) || 0,
  };
}
/* isPlayable()：只有账号/播放结果均为 allowed 且存在音源，才允许进入可播放画廊；待确认不等于免费或已授权。 */
function isPlayable(result, track) {
  return (
    result.state === 'allowed' && result.playbackState === 'allowed' && (!!track.audio || result.playable === true)
  );
}
/* rememberLocal()：把后端返回的虚拟歌单计数合并到下拉列表；local 为空时不做任何操作。 */
function rememberLocal(local) {
  if (!local) return;
  const old = playlistRows.find((p) => p.id === local.id);
  if (old) Object.assign(old, local);
  else playlistRows.push(local);
  renderPlaylists();
}
/* renderPlaylists()：重建歌单下拉项，给本地虚拟歌单显示数量，并尽量保留当前选中值。 */
function renderPlaylists() {
  const value = $('playlists').value;
  $('playlists').replaceChildren(new Option('选择你的歌单', ''));
  for (const p of playlistRows)
    $('playlists').add(new Option(p.name + (p.local ? `（${p.count}）` : ''), p.id));
  $('playlists').value = value;
}
/* loadPlaylists()：读取当前账号歌单，保存到 playlistRows 后更新下拉框；不自动替用户选择或播放。 */
async function loadPlaylists() {
  const d = await request('playlists');
  playlistRows = d.playlists || [];
  renderPlaylists();
  status('选择一份歌单，检查可播放歌曲');
}
// 有界预加载缓存：当前曲和前后曲共享同一次下载，不往画廊插入额外 DOM。
const coverCache = new Map();
/* preloadCover()：按 URL 缓存一次封面加载 Promise；先下载并解码，成功后返回 URL。
 * 15 秒无响应视为失败；失败移出缓存可重试；最多保留 24 项，避免长歌单无限占用内存。 */
function preloadCover(url) {
  const key = url || FALLBACK;
  if (coverCache.has(key)) return coverCache.get(key);
  const promise = new Promise((resolve, reject) => {
    const image = new Image();
    let timer;
    const clean = () => {
      clearTimeout(timer);
      image.onload = image.onerror = null;
    };
    image.onload = async () => {
      try {
        await image.decode?.();
        clean();
        resolve(key);
      } catch (e) {
        clean();
        reject(e);
      }
    };
    image.onerror = () => {
      clean();
      reject(Error('封面加载失败'));
    };
    timer = setTimeout(() => {
      clean();
      reject(Error('封面加载超时'));
    }, 15000);
    image.src = key;
  });
  coverCache.set(key, promise);
  promise.catch(() => {
    if (coverCache.get(key) === promise) coverCache.delete(key);
  });
  while (coverCache.size > 24) coverCache.delete(coverCache.keys().next().value);
  return promise;
}
/* wrapIndex()：把任意正负索引折回 0…songs.length-1，实现首尾循环；空歌单返回 -1。 */
function wrapIndex(value) {
  return songs.length ? ((value % songs.length) + songs.length) % songs.length : -1;
}
/* preloadNeighbors()：预取当前曲前后各 6 首的封面，超出列表边界时循环；只预加载图片，不创建额外卡片。 */
function preloadNeighbors() {
  if (songs.length)
    for (let offset = -6; offset <= 6; offset++)
      preloadCover(songs[wrapIndex(index + offset)].cover).catch(() => {});
}
/* paintCover()：给一个 img 绑定新封面，下载时先隐藏旧图。
 * 通过 coverVersion 丢弃迟到回调，防止快速切歌显示错封面；失败时回退 FALLBACK 占位。 */
function paintCover(img, url) {
  const key = url || FALLBACK;
  if (img.dataset.coverUrl === key) return;
  const version = String(Number(img.dataset.coverVersion || 0) + 1);
  img.dataset.coverVersion = version;
  img.dataset.coverUrl = key;
  img.onload = img.onerror = null;
  img.classList.remove('is-loaded');
  img.removeAttribute('src');
  /* 回调执行前确认图片仍绑定这一版本，防止旧图先后到达顺序不同造成串图。 */
  const current = () => img.dataset.coverVersion === version;
  const fail = () => {
    if (!current()) return;
    img.onload = img.onerror = null;
    if (key !== FALLBACK) paintCover(img, FALLBACK);
  };
  preloadCover(key).then(() => {
    if (!current()) return;
    const reveal = async () => {
      try {
        await img.decode?.();
        if (current()) img.classList.add('is-loaded');
      } catch {
        fail();
      }
    };
    img.onload = reveal;
    img.onerror = fail;
    img.src = key;
    if (img.complete && img.naturalWidth > 0) reveal();
  }, fail);
}
/* fillCard()：填充一张可复用卡片。offset 是相对当前曲的位置，范围通常为 -4…4。
 * --offset 交给 CSS 计算水平位置；h1 是画廊歌名，p 是歌手，字号在 style.css。 */
function fillCard(card, offset) {
  const at = wrapIndex(index + offset),
    song = songs[at];
  card.style.setProperty('--offset', offset);
  card.dataset.offset = String(offset);
  card.style.visibility =
    song && (songs.length > 1 || offset === 0) ? 'visible' : 'hidden';
  card.setAttribute('aria-hidden', String(offset !== 0));
  const img = card.querySelector('img');
  paintCover(img, song?.cover);
  img.alt = song ? `${song.title} 封面` : '';
  card.querySelector('h1').textContent = song?.title || '';
  card.querySelector('p').textContent = song?.artist || '';
  card.querySelector('.number').textContent = song
    ? `${String(at + 1).padStart(2, '0')} / ${songs.length}`
    : '';
}
/* renderGallery()：刷新九张卡片、沉浸标题、唱片封面及当前背景。
 * reset=true 暂时关掉位移过渡，用于首次显示或直接跳转；false 保留 CSS 平移动画。 */
function renderGallery(reset = true) {
  const selected = songs[index];
  $('immersiveTitle').textContent = selected?.title || '选择你的第一首歌';
  $('immersiveArtist').textContent = selected?.artist || '你的私人音乐空间';
  $('recordNumber').textContent = '唱片 ' + String(index + 1).padStart(2, '0');
  $('immersiveTitle').title = selected?.title || '';
  if (reset) $('rail').classList.add('no-transition');
  cards.forEach((card, i) => fillCard(card, i - 4));
  if (reset) {
    void $('rail').offsetWidth;
    $('rail').classList.remove('no-transition');
  }
  $('rail').hidden = !songs.length;
  $('empty').hidden = !!songs.length;
  $('previous').disabled = $('next').disabled = !songs.length;
  $('toggle').disabled = !songs.length;
  $('backgroundOpen').disabled = !songs.length;
  preloadNeighbors();
  paintCover($('discCover'), songs[index]?.cover);
  setBackground();
}
/* stopAudio()：取消延迟播放和旧播放请求，暂停并清空 audio，清除歌词/唱片状态。
 * playVersion 递增使尚未完成的旧异步结果失效，常用于换歌单或退出账号。 */
function stopAudio() {
  automaticSeek = null;
  clearTimeout(playTimer);
  playVersion++;
  automaticSeek = null;
  listening.reset();
  clearTimeout(recoveryTimer);
  playAbort?.abort();
  audio.pause();
  stopLyricSync();
  resetLyrics('让音乐慢下来。');
  audio.removeAttribute('src');
  audio.load();
  loadedId = '';
  loadingAudio = false;
  $('vinyl').classList.remove('playing');
}
/* selectPlaylist()：选择普通歌单时重置播放/随机历史，拉取全部歌曲后逐首检查。
 * 本地“暂不可播放”只打开结果弹窗；viewVersion 用来隔离先前歌单请求。 */
async function selectPlaylist() {
  if (busy) {
    status('请先停止当前检查');
    return;
  }
  const id = $('playlists').value;
  if (!id) return;
  if (id === 'local:unauthorized') {
    await openRejected();
    return;
  }
  const version = ++viewVersion;
  stopAudio();
  songs = [];
  rawTracks = [];
  rejected = [];
  index = 0;
  playbackQueue.reset();
  checkedIds.clear();
  renderGallery();
  status('正在读取歌单…');
  try {
    const d = await request('tracks?playlist=' + encodeURIComponent(id));
    if (version !== viewVersion) return;
    rawTracks = d.tracks || [];
    await checkAll(rawTracks, version);
  } catch (e) {
    if (version === viewVersion) status(e.message);
  }
}
/* checkAll()：串行检查 rows 的完整音源；可以中途请求停止，但当前请求结束后才真正退出。
 * 用 Map 按歌曲 ID 合并成功与失败，逐首更新画廊；finally 恢复按钮和进度条。 */
async function checkAll(rows = rawTracks.filter((t) => !checkedIds.has(t.id)), version = viewVersion, fresh = false) {
  if (busy) return;
  if (sliding || flashing) return status('请等待切歌动画结束');
  busy = true;
  stopCheck = false;
  $('check').textContent = '停止检查';
  $('playlists').disabled = true;
  /* 沿用已入选/失败结果，支持停止后续查或仅重试失败歌曲，不从头清空整个画廊。 */
  const admitted = new Map(songs.map((s) => [s.id, s]));
  const failures = new Map(rejected.map((t) => [t.id, t]));
  try {
    for (let n = 0; n < rows.length; n++) {
      if (stopCheck || version !== viewVersion) break;
      const raw = rows[n];
      status(`确认音源 ${n + 1}/${rows.length}：${raw.title}`);
      $('progress').style.width = `${((n + 1) / rows.length) * 100}%`;
      try {
        const result = await request('inspect?track=' + encodeURIComponent(raw.id) + (fresh ? '&fresh=1' : '') + (fresh && n === 0 ? '&accountFresh=1' : ''), 'POST', () => version === viewVersion && !stopCheck, { priority: -10 });
        if (version !== viewVersion) break;
        rememberLocal(result.localPlaylist);
        checkedIds.add(raw.id);
        const track = cleanTrack(raw, result);
        if (isPlayable(result, track)) {
          // 封面只使用后端/平台返回的网络 URL；没有封面时显示明确的灰色占位。
          if (!track.cover) {
            try {
              const art = await request('cover?track=' + encodeURIComponent(track.id), 'GET', () => version === viewVersion, { priority: -10 });
              track.cover = https(art.cover);
            } catch {}
          }
          admitted.set(track.id, track);
          failures.delete(track.id);
        } else {
          admitted.delete(track.id);
          failures.set(String(raw.id), {
            ...raw,
            ...accessSummary(result),
          });
        }
      } catch (e) {
        admitted.delete(String(raw.id));
        if (e.name === 'AbortError') break;
        failures.set(String(raw.id), { ...raw, category: 'network', reason: '检查请求失败，可重试', playbackReason: e.message });
      }
      if (version !== viewVersion) break;
      /* 用稳定 ID 保住当前歌曲位置，避免检查过程中新增歌曲导致索引指向另一首。 */
      const oldId = songs[index]?.id;
      songs = rawTracks.map((t) => admitted.get(String(t.id))).filter(Boolean);
      if (oldId && loadedId === oldId && !songs.some((t) => t.id === oldId)) stopAudio();
      rejected = [...failures.values()];
      index = Math.max(
        0,
        songs.findIndex((t) => t.id === oldId),
      );
      renderGallery();
    }
  } finally {
    busy = false;
    $('check').textContent = checkedIds.size < rawTracks.length ? '继续检查' : '重新检查';
    $('playlists').disabled = false;
    $('progress').style.width = '0';
    if (version === viewVersion) {
      status(
        `${songs.length} 首有完整音源，${rejected.length} 首未入选${stopCheck ? ' · 已停止' : ''}`,
      );
      renderRejected();
    }
  }
}
/* loadSource()：尝试一条主/备音源。signal 控制切歌取消，expected 是预期完整时长（秒）。
 * 只在 playing 事件发生后成功；时长过短、加载失败、超时或取消都会退出并清理事件。 */
function loadSource(url, signal, expected) {
  return HigherPlayer.loadAudio(audio, url, signal, 15000, expected);
}
/* playCurrent()：重新确认当前歌曲的完整音源，依次尝试主/备线路，然后记录播放历史并请求歌词。
 * playVersion 防止旧请求覆盖新曲，playAbort 用于中止旧媒体加载；浏览器禁止自动播放时提示再次点击。 */
async function playCurrent(resumeAt = 0, recovering = false) {
  const song = songs[index];
  if (!song) return;
  clearTimeout(playTimer);
  playTimer = null;
  const version = ++playVersion;
  automaticSeek = null;
  if (recovering) listening.suspend();
  else listening.reset();
  clearTimeout(recoveryTimer);
  if (!recovering || recoverySong !== song.id) { recoverySong = song.id; recoveryAttempts = 0; }
  playAbort?.abort();
  playAbort = new AbortController();
  const signal = playAbort.signal;
  loadingAudio = true;
  audio.pause();
  resetLyrics();
  loadedId = '';
  status('正在确认并加载 ' + song.title);
  try {
    const d = await request(
      'play?track=' + encodeURIComponent(song.id),
      'POST',
      () => version === playVersion,
    );
    if (version !== playVersion) return;
    rememberLocal(d.localPlaylist);
    const fresh = cleanTrack(song, d);
    if (!isPlayable(d, fresh)) {
      rejected = rejected.filter((t) => t.id !== song.id);
      rejected.push({ ...song, ...accessSummary(d) });
      songs = songs.filter((t) => t.id !== song.id);
      index = Math.min(index, Math.max(0, songs.length - 1));
      renderGallery();
      throw Error(d.reason || '当前音源待确认，已移出画廊');
    }
    Object.assign(song, {
      audio: fresh.audio,
      urls: fresh.urls,
      duration: fresh.duration,
    });
    /* 主线路失败再尝试备用线路；用户取消或自动播放限制应立即退出，不盲目换线路。 */
    let loaded = false;
    for (const url of song.urls) {
      try {
        await loadSource(url, signal, song.duration);
        loaded = true;
        break;
      } catch (e) {
        if (e.name === 'AbortError' || e.name === 'NotAllowedError') throw e;
      }
    }
    if (!loaded) throw Error('主备音源均无法加载，请重试');
    if (version !== playVersion) return;
    loadedId = song.id;
    loadingAudio = false;
    playbackQueue.select(song.id);
    if (!recovering || !listening.round || listening.round.songId !== song.id) listening.begin(song, audio);
    if (resumeAt > 0 && Number.isFinite(audio.duration)) {
      const target = Math.min(resumeAt, Math.max(0, audio.duration - 0.1));
      automaticSeek = { version, target };
      listening.suspend();
      audio.currentTime = target;
      // 某些媒体在同位置赋值时不会派发 seeked。
      if (!audio.seeking) { automaticSeek = null; listening.resume(audio); }
    } else listening.resume(audio);
    status('正在播放 · 完整音源');
    loadLyrics(song, version);
  } catch (e) {
    if (version !== playVersion) return;
    loadingAudio = false;
    if (e.name === 'NotAllowedError') {
      loadedId = song.id;
      if (!recovering || !listening.round) listening.begin(song, audio);
      listening.suspend();
      status('请再次点击播放按钮');
    } else if (e.name !== 'AbortError') status(e.message);
  }
}
// UI 立即提交，音频请求短暂合并；任何下载/权限请求都不能阻塞画廊。
/* goTo()：切到目标索引，立即更新画廊，120ms 合并后再异步加载音频。
 * directionHint 指定跨首尾的移动方向；1–3 格通过循环复用边缘卡片实现平移，远距离可直接重绘。 */
function goTo(target, animate = true, directionHint = 0) {
  if (flashing || !songs.length) return;
  target = wrapIndex(target);
  if (target === index) return;
  const direction = directionHint || Math.sign(target - index);
  // 首尾相邻仍按一格处理；搜索跨 2–3 首时一次平移对应格数。
  const steps = wrapIndex(index + direction) === target
    ? 1
    : Math.abs(target - index);
  clearTimeout(playTimer);
  playVersion++;
  automaticSeek = null;
  listening.reset();
  clearTimeout(recoveryTimer);
  playAbort?.abort();
  audio.pause();
  loadingAudio = false;
  resetLyrics();
  const recycled = [];
  if (animate && steps <= 3 && !reducedMotion.matches) {
    for (let n = 0; n < steps; n++) {
      const card = direction > 0 ? cards.shift() : cards.pop();
      if (direction > 0) cards.push(card);
      else cards.unshift(card);
      card.style.transition = 'none';
      recycled.push(card);
    }
  }
  index = target;
  renderGallery(recycled.length === 0);
  if (recycled.length) {
    void $('rail').offsetWidth;
    for (const card of recycled) card.style.transition = '';
  }
  playTimer = setTimeout(() => {
    playTimer = null;
    playCurrent();
  }, 120);
}
/* advance()：上一首/下一首的统一入口，direction 为 -1/+1；ended 表示自然播放完毕。
 * 顺序模式首尾循环；单曲循环只在自然结束时重播；随机模式维护真实历史和一轮不重复的抽签袋。 */
function advance(direction, ended = false) {
  if (!songs.length || flashing) return;
  if ($('mode').value && playbackQueue.mode !== $('mode').value) playbackQueue.setMode($('mode').value);
  const ids = songs.map((song) => song.id);
  const current = songs[index].id;
  const target = direction < 0 ? playbackQueue.previous(ids, current)
    : playbackQueue.next(ids, current, { ended });
  if (!target) return;
  if (target === current) { if (ended) playCurrent(); return; }
  goTo(ids.indexOf(target), true, $('mode').value === 'shuffle' ? 0 : direction);
}
lyricMinus.onclick = () => adjustLyricOffset(-0.1);
lyricPlus.onclick = () => adjustLyricOffset(0.1);
updateOffsetLabel();
let searchMatches = [];
bindSearch();
/* openRejected()：合并服务端虚拟歌单与本次未入选结果，并打开原因列表；不会改动云端歌单。 */
async function openRejected() {
  if (!$('rejectedDialog').open) $('rejectedDialog').showModal();
  try {
    const d = await request('tracks?playlist=local%3Aunauthorized');
    const byId = new Map(rejected.map((t) => [String(t.id), t]));
    for (const t of d.tracks || [])
      if (!songs.some((s) => s.id === String(t.id))) byId.set(String(t.id), t);
    rejected = [...byId.values()];
  } catch {}
  renderRejected();
}
/* renderRejected()：用 textContent 创建歌曲名与原因，避免把平台文本当作 HTML 解析。 */
function renderRejected() {
  const list = $('rejectedList');
  list.replaceChildren();
  const filter = $('rejectedFilter').value || 'all';
  let shown = 0;
  for (const t of rejected) {
    if (filter !== 'all' && accessCategory(t) !== filter) continue;
    shown++;
    const row = document.createElement('div'),
      name = document.createElement('strong'),
      reason = document.createElement('small');
    name.textContent = t.title;
    reason.textContent = `账号权益：${t.entitlementReason || t.reason || '待确认'}；音源：${t.playbackReason || '待确认'}`;
    row.append(name, reason);
    list.append(row);
  }
  if (!shown) list.textContent = '当前分类没有暂不可播放的歌曲。';
}
/* closeLogin()：关闭扫码框、停止轮询，并递增 loginVersion，让旧二维码请求失效。 */
function closeLogin() {
  loginVersion++;
  clearTimeout(pollTimer);
  $('loginDialog').close();
}
/* login()：请求二维码，每 3 秒轮询状态。0 表示过期，2 等待手机确认，4 登录成功。
 * 所有回调检查 loginVersion，关窗或刷新二维码后旧轮询不能再次更新界面。 */
async function login() {
  const version = ++loginVersion;
  clearTimeout(pollTimer);
  if (!$('loginDialog').open) $('loginDialog').showModal();
  $('qr').hidden = true;
  $('qrStatus').textContent = '正在获取二维码…';
  $('refreshQR').disabled = true;
  try {
    const d = await request('login', 'POST');
    if (version !== loginVersion) return;
    if (typeof d.image !== 'string' || !d.image.startsWith('data:image/'))
      throw Error('二维码数据无效');
    $('qr').src = d.image;
    $('qr').hidden = false;
    $('qrStatus').textContent = '请使用手机酷狗扫码确认';
    const poll = async () => {
      if (version !== loginVersion) return;
      try {
        const state = await request('login/status');
        if (version !== loginVersion) return;
        if (state.status === 4) {
          closeLogin();
          setAccount(state.user);
          await loadPlaylists();
          return;
        }
        if (state.status === 0) {
          $('qrStatus').textContent = '二维码已过期，请刷新';
          return;
        }
        $('qrStatus').textContent =
          state.status === 2 ? '请在手机上确认登录' : '等待扫码…';
        pollTimer = setTimeout(poll, 3000);
      } catch (e) {
        if (version === loginVersion) $('qrStatus').textContent = e.message;
      }
    };
    pollTimer = setTimeout(poll, 3000);
  } catch (e) {
    if (version === loginVersion) $('qrStatus').textContent = e.message;
  } finally {
    if (version === loginVersion) $('refreshQR').disabled = false;
  }
}
/* setAccount()：只更新扫码/退出按钮的可见性；真实登录状态仍由后端会话决定。 */
function setAccount(user) {
  listening.cancelPending();
  $('scan').hidden = !!user;
  $('logout').hidden = !user;
  $('emptyScan').hidden = !!user;
}
/* 【登录事件】扫码、空态连接和刷新二维码共用 login；所有带 data-close 的按钮按目标关闭对应弹窗。 */
$('scan').onclick = $('emptyScan').onclick = $('refreshQR').onclick = login;
for (const button of document.querySelectorAll('[data-close]'))
  button.onclick = () =>
    button.dataset.close === 'loginDialog'
      ? closeLogin()
      : $(button.dataset.close).close();
$('loginDialog').addEventListener('cancel', closeLogin);
/* 【退出事件】先使旧请求失效并停播，再让后端销毁会话；成功后清空本页歌曲、歌单和账号按钮。 */
$('logout').onclick = async () => {
  listening.cancelPending();
  stopCheck = true;
  viewVersion++;
  stopAudio();
  closeLogin();
  try {
    await request('logout', 'POST');
    songs = [];
    rawTracks = [];
    rejected = [];
    playlistRows = [];
    renderPlaylists();
    renderGallery();
    setAccount(null);
    status('已退出');
  } catch (e) {
    status(e.message);
  }
};
/* 【歌单事件】下拉选择、开始/停止权限检查、只重试当前原歌单内未入选的记录。 */
$('playlists').onchange = () => selectPlaylist().catch((e) => status(e.message));
$('check').onclick = () => {
  if (busy) {
    stopCheck = true;
    status('将在当前请求完成后停止');
  } else if (rawTracks.length) {
    if (checkedIds.size >= rawTracks.length) checkAll(rawTracks, viewVersion, true);
    else checkAll();
  }
  else status('先选择一份歌单');
};
$('retryRejected').onclick = () => {
  if (!rawTracks.length) return status('先选择原歌单，再重新检查');
  const filter = $('rejectedFilter').value || 'all';
  checkAll(rejected.filter((t) => (filter === 'all' || accessCategory(t) === filter) && rawTracks.some((r) => String(r.id) === String(t.id))), viewVersion, true);
};
/* 【工具按钮】搜索、背景选择、清除当前歌曲背景。 */
$('searchOpen').onclick = search;
$('backgroundOpen').onclick = openBackgrounds;
$('clearBackground').onclick = () => saveBackground('');
/* 【沉浸自动隐去选项】仅在沉浸模式启用，停止操作 1000ms 后隐藏顶部选项和光标。
 * 复用单个计时器；移动、按键或操作控件立即唤醒，退出沉浸模式会取消计时并清除状态。
 * 弹窗、正在输入、键盘焦点与按住指针期间不隐藏，避免打断搜索、下拉选择或拖动进度条。 */
let immersiveIdleTimer = null;
let immersivePointerHeld = false;
function wakeImmersiveControls() {
  clearTimeout(immersiveIdleTimer);
  immersiveIdleTimer = null;
  document.body.classList.remove('controls-idle');
  if (!document.body.classList.contains('immersive') || document.hidden) return;
  immersiveIdleTimer = setTimeout(() => {
    immersiveIdleTimer = null;
    const focused = document.activeElement;
    const editing = focused?.matches('input,textarea,select,[contenteditable]');
    const keyboardControl = focused?.closest('header .tools') && focused.matches(':focus-visible');
    if (immersivePointerHeld || document.querySelector('dialog[open]') || editing || keyboardControl) return;
    document.body.classList.add('controls-idle');
  }, 1000);
}
document.addEventListener('pointermove', wakeImmersiveControls, { passive: true });
document.addEventListener('pointerdown', () => {
  immersivePointerHeld = true;
  wakeImmersiveControls();
}, { passive: true });
function releaseImmersivePointer() {
  immersivePointerHeld = false;
  wakeImmersiveControls();
}
document.addEventListener('pointerup', releaseImmersivePointer, { passive: true });
document.addEventListener('pointercancel', releaseImmersivePointer, { passive: true });
document.addEventListener('lostpointercapture', releaseImmersivePointer);
// 捕获阶段唤醒，使 Tab 在执行默认焦点移动前就能找到顶部控件。
document.addEventListener('keydown', wakeImmersiveControls, true);
document.addEventListener('focusin', wakeImmersiveControls);
document.addEventListener('focusout', wakeImmersiveControls);
document.addEventListener('close', wakeImmersiveControls, true);
document.addEventListener('visibilitychange', releaseImmersivePointer);
document.defaultView?.addEventListener('blur', releaseImmersivePointer);

/* toggleImmersive()：切换 body.immersive 和顶部按钮文本，由 CSS 控制画廊/沉浸布局。
 * 不改 audio 的地址、进度或播放状态，因此切换视图不会重新播放歌曲。 */
function toggleImmersive() {
  const active = document.body.classList.toggle('immersive');
  wakeImmersiveControls();
  $('viewToggle').setAttribute('aria-pressed', String(active));
  $('viewToggle').textContent = active ? '画廊 · F' : '沉浸 · F';
  // 只切换视觉状态：不调用 pause/play/load，不修改 src/currentTime。
  document
    .querySelector('.station')
    .animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 350, easing: 'ease-out' });
}
$('viewToggle').onclick = toggleImmersive;
/* recordState()：切换唱机外壳的 is-playing 类；CSS 据此让唱臂落下或抬起，唱片旋转另由 vinyl.playing 控制。 */
function recordState(playing) {
  document.querySelector('.record-deck').classList.toggle('is-playing', playing);
}
/* 【播放按钮】上一首/下一首走统一 advance；改变播放模式时清空随机抽签袋。 */
$('previous').onclick = () => advance(-1);
$('next').onclick = () => advance(1);
$('mode').onchange = () => {
  playbackQueue.setMode($('mode').value);
  $('previous').disabled = $('next').disabled = !songs.length;
};
/* 【播放/暂停】尚未加载当前曲时重新确认音源；否则沿用当前 audio 进度继续或暂停。 */
$('toggle').onclick = () => {
  if (loadingAudio || flashing || sliding) return;
  if (loadedId !== songs[index]?.id) playCurrent();
  else if (audio.paused) audio.play().catch(() => status('请再次点击播放'));
  else audio.pause();
};
$('rejectedFilter').onchange = renderRejected;
audio.addEventListener('timeupdate', () => listening.tick(audio));
audio.addEventListener('playing', () => {
  clearTimeout(recoveryTimer);
  if (!automaticSeek && !loadingAudio) listening.resume(audio);
});
for (const event of ['pause', 'waiting', 'ended', 'emptied', 'error'])
  audio.addEventListener(event, () => listening.suspend());
audio.addEventListener('seeking', () => {
  if (automaticSeek?.version === playVersion && Math.abs(audio.currentTime - automaticSeek.target) < 0.2) listening.suspend();
  else { automaticSeek = null; listening.seek(); }
});
audio.addEventListener('seeked', () => {
  automaticSeek = null;
  if (!audio.paused) listening.resume(audio);
});
audio.addEventListener('ratechange', () => listening.resume(audio));
// 中途故障最多自动刷新一次音源，保留进度；不重试历史提交，不恢复拖动后的上报资格。
function scheduleRecovery(immediate = false) {
  if (loadingAudio || !loadedId || recoveryAttempts >= 1 || flashing) return;
  clearTimeout(recoveryTimer);
  const id = loadedId, version = playVersion;
  recoveryTimer = setTimeout(() => {
    if (version !== playVersion || songs[index]?.id !== id || audio.ended || audio.paused && !audio.error) return;
    recoveryAttempts++;
    const position = audio.currentTime;
    status('音源中断，正在恢复播放…');
    playCurrent(position, true);
  }, immediate ? 0 : 12000);
}
audio.addEventListener('waiting', () => scheduleRecovery());
audio.addEventListener('stalled', () => scheduleRecovery());
audio.addEventListener('error', () => scheduleRecovery(true));
audio.addEventListener('pause', () => clearTimeout(recoveryTimer));
/* 【媒体事件】唱片旋转和唱臂状态随实际 audio 事件更新；歌词从 playing 才启动逐帧同步。 */
audio.onplay = () => {
  recordState(true);
  $('toggle').textContent = 'Ⅱ';
  $('vinyl').classList.add('playing');
};
audio.onplaying = startLyricSync;
audio.onpause = () => {
  recordState(false);
  stopLyricSync();
  updateLyrics();
  $('toggle').textContent = '▶';
  $('vinyl').classList.remove('playing');
  if (!loadingAudio && loadedId) status('已暂停');
};
audio.onended = () => {
  recordState(false);
  stopLyricSync();
  advance(1, true);
};
audio.onseeking = audio.onseeked = updateLyrics;
audio.addEventListener('emptied', stopLyricSync);
/* 页面切到后台先停歌词逐帧任务，回到前台按当前音频时间重新定位，不从旧歌词继续数。 */
document.addEventListener('visibilitychange', () => {
  stopLyricSync();
  updateLyrics();
  if (!document.hidden) startLyricSync();
});
/* 【进度栏】timeupdate 只刷新时间文字和滑块；歌词使用更细的 requestAnimationFrame。 */
audio.ontimeupdate = () => {
  $('elapsed').textContent = time(audio.currentTime);
  $('duration').textContent = time(audio.duration);
  $('seek').value =
    Number.isFinite(audio.duration) && audio.duration > 0
      ? (audio.currentTime / audio.duration) * 1000
      : 0;
};
/* 进度滑块范围 0…1000，按比例转换成音频秒数，duration 有效时才允许跳转。 */
$('seek').oninput = () => {
  automaticSeek = null;
  listening.seek();
  if (Number.isFinite(audio.duration))
    audio.currentTime = (Number($('seek').value) / 1000) * audio.duration;
};
/* 音量滑块是 0…1；修改后同步可视填色与无障碍描述。 */
$('volume').oninput = () => {
  audio.volume = Number($('volume').value);
  syncVolume();
};
/* syncVolume()：把 audio.volume 的 0…1 同步为滑块数值、百分比填色和无障碍提示。 */
function syncVolume() {
  const value = Math.round(audio.volume * 100);
  $('volume').value = audio.volume;
  $('volume').style.setProperty('--volume-level', value + '%');
  $('volume').setAttribute('aria-valuetext', value + '%');
  $('volumeControl').title = '音量 ' + value + '%';
}
audio.onvolumechange = syncVolume;
/* 【可调参数】页面初始音量 70%；此处不会从浏览器存储恢复音量。 */
audio.volume = 0.7;
syncVolume();
/* 【键盘】输入框/下拉框/弹窗内不拦截按键；F 切视图，I 搜索，左右切歌，空格播放暂停。 */
document.addEventListener('keydown', (e) => {
  if (
    e.target.closest('input,select,textarea,[contenteditable="true"]') ||
    document.querySelector('dialog[open]')
  )
    return;
  if (e.key.toLowerCase() === 'f') {
    e.preventDefault();
    toggleImmersive();
  } else if (e.key.toLowerCase() === 'i') {
    e.preventDefault();
    search();
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    advance(1);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    advance(-1);
  } else if (e.code === 'Space') {
    e.preventDefault();
    $('toggle').click();
  }
});
document.addEventListener(
  /* 【滚轮】只处理主要为纵向的滚动；220ms 内累计到 70px 才切歌，减少触控板轻微移动导致误触。 */
  'wheel',
  (e) => {
    if (document.querySelector('dialog[open]')) return;
    e.preventDefault();
    if (flashing || Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
    const now = performance.now();
    if (now - wheelAt > 220) wheelSum = 0;
    wheelAt = now;
    wheelSum += e.deltaY * (e.deltaMode === 1 ? 16 : 1);
    if (Math.abs(wheelSum) >= 70) {
      advance(wheelSum > 0 ? 1 : -1);
      wheelSum = 0;
    }
  },
  { passive: false },
);
/* 【拖动】仅画廊模式响应主指针；按下时捕获指针，移动时临时平移 rail，松手后由 finishDrag 决定切歌。 */
let drag = null;
$('stage').addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || drag || flashing || document.body.classList.contains('immersive')) return;
  // 编辑与交互控件保留原生行为，不捕获它们的指针，也不影响输入框选择文字。
  if (e.target.closest('input,textarea,select,button,a,[contenteditable]')) return;
  drag = { id: e.pointerId, x: e.clientX };
  $('stage').classList.add('is-dragging');
  $('stage').setPointerCapture(e.pointerId);
});
$('stage').addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  $('rail').style.transform = `translateX(${e.clientX - drag.x}px)`;
});
/* finishDrag()：结束当前指针拖动，复位轨道临时位移；有效拖动超过 45px 时切歌，取消或丢失指针捕获时不切歌，并恢复抓手。 */
function finishDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const distance = e.clientX - drag.x;
  drag = null;
  $('stage').classList.remove('is-dragging');
  $('rail').style.transform = '';
  if (e.type === 'pointerup' && Math.abs(distance) > 45)
    advance(distance < 0 ? 1 : -1);
}
$('stage').addEventListener('pointerup', finishDrag);
$('stage').addEventListener('pointercancel', finishDrag);
// 窗口失焦等情况可能结束指针捕获，同样清理状态，避免抓手卡在 grabbing。
$('stage').addEventListener('lostpointercapture', finishDrag);
renderGallery();
/* 【启动】先渲染空画廊，再向后端恢复当前会话；已有登录时读取歌单，否则提示扫码。 */
(async () => {
  if (location.protocol === 'file:') {
    status('请通过 http://127.0.0.1:3211/ 打开；双击文件无法共享登录会话');
    return;
  }
  try {
    const d = await request('session');
    setAccount(d.user);
    if (d.user) await loadPlaylists();
    else status(d.ready ? '连接已就绪，请扫码登录' : '请先启动并安装后端连接组件');
  } catch (e) {
    status('无法连接后端：' + e.message);
  }
})();
