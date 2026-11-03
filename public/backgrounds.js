/* 【自定义背景逻辑】
 * 浏览器不能任意读取 D: 路径或自动列出文件夹。本项目由 Node 提供
 * GET /api/backgrounds 及 /Image169/<文件名>，读取 index.html 旁的 Image169。
 * localStorage 仅保存 {稳定歌曲ID: 文件名}，不保存图片内容或临时 blob URL。
 * 再次切到该曲，按 ID 取文件名；不存在/读取失败时回退 #121212。
 * 背景只允许来自 Image169；未设置或图片失效时使用默认深色，绝不使用专辑封面。
 * 双背景层只改变透明度；原图不模糊，图片失效不影响音频播放。
 */
const BG_KEY = 'higherweb.backgrounds.v1';
/* readBackgroundMap()：读取 {歌曲稳定 ID: Image169 文件名}；存储损坏或不可读时返回空对象。 */
function readBackgroundMap() {
  try {
    const value = JSON.parse(localStorage.getItem(BG_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
/* safeImageName()：只接受没有路径分隔符的 png/jpg/jpeg/webp/avif 文件名，阻止前端传入任意路径。 */
function safeImageName(name) {
  return (
    typeof name === 'string' &&
    !/[\\/]/.test(name) &&
    /\.(png|jpe?g|webp|avif)$/i.test(name)
  );
}
/* imagePath()：把合法文件名编码为同源 /Image169/ 地址；空格和中文由 encodeURIComponent 处理。 */
function imagePath(name) {
  return API_BASE + '/Image169/' + encodeURIComponent(name);
}
/* setBackground()：按当前歌曲 ID 恢复自定义背景，解码成功后在 bgA/bgB 双层间交叉淡入。
 * bgVersion 防止旧图迟到覆盖新曲；无设置或图片失效时显露默认深色，绝不借用专辑封面。 */
async function setBackground() {
  const version = ++bgVersion,
    song = songs[index],
    name = song ? readBackgroundMap()[song.id] : '';
  let url = '';
  if (safeImageName(name)) {
    const test = new Image();
    test.src = imagePath(name);
    try {
      await test.decode();
      url = test.src;
    } catch {}
  }
  if (version !== bgVersion) return;
  // 只有 Image169 的原图可以进入背景层；空 URL 让默认深色背景显露。
  const next = backgroundSide ? $('bgA') : $('bgB'),
    old = backgroundSide ? $('bgB') : $('bgA');
  next.style.backgroundImage = url ? `url("${url}")` : 'none';
  next.classList.add('active');
  old.classList.remove('active');
  backgroundSide = 1 - backgroundSide;
}
/* saveBackground()：为当前歌曲保存文件名；空字符串表示清除映射。保存后更新背景并关闭选择框。 */
function saveBackground(name) {
  const song = songs[index];
  if (!song) return;
  const map = readBackgroundMap();
  if (name) map[song.id] = name;
  else delete map[song.id];
  try {
    localStorage.setItem(BG_KEY, JSON.stringify(map));
    setBackground();
    $('backgroundDialog').close();
    status(name ? '已为这首歌保存背景' : '已恢复默认深色背景');
  } catch {
    status('浏览器不允许保存本地背景设置');
  }
}
/* openBackgrounds()：向后端读取 Image169 目录并生成缩略图按钮，点击后调用 saveBackground。
 * 仅展示可用图片，不上传图片，也不会直接读取用户磁盘的任意文件夹。 */
async function openBackgrounds() {
  if (!songs[index]) return;
  $('backgroundDialog').showModal();
  $('backgroundOptions').replaceChildren();
  $('backgroundHint').textContent = '正在读取 Image169…';
  try {
    const d = await request('backgrounds');
    $('backgroundHint').textContent = d.images.length
      ? '为「' + songs[index].title + '」选择一张背景。'
      : '请把横图放入 index.html 旁的 Image169 文件夹，再重新打开这里。';
    for (const name of d.images.filter(safeImageName)) {
      const button = document.createElement('button'),
        img = document.createElement('img'),
        label = document.createElement('span');
      img.src = imagePath(name);
      img.alt = '';
      img.loading = 'lazy';
      label.textContent = name;
      button.append(img, label);
      button.onclick = () => saveBackground(name);
      $('backgroundOptions').append(button);
    }
  } catch (e) {
    $('backgroundHint').textContent = e.message;
  }
}
