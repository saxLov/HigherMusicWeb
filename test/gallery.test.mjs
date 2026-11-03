/* 自动检查：画廊与前端交互：九节点复用、封面竞态、快闪、背景持久化、歌词偏移与视图切换。
 * 使用 Node 内置 node:test 与 assert；每个中文 test 标题说明场景，assert 是预期结果。
 * 桩数据用于可重复的本地验证，不代表平台当次真实权益；运行 node --test test/*.test.mjs。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { coverUrl, backgroundFile } from '../lib/gallery.mjs';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const script = (await Promise.all(['player-core.js', 'listening.js', 'api-client.js', 'lyrics.js', 'backgrounds.js', 'search.js', 'app.js'].map((file) => readFile(new URL('../public/' + file, import.meta.url), 'utf8')))).join('\n');
/* 前端测试环境：用最小 DOM、图片、媒体、localStorage 和计时器替身执行真实 app.js。
 * frames 记录快闪歌名，delays 记录等待毫秒数；测试加速等待，不衡量真实屏幕动画观感。 */
function harness({ autoImages = true, savedOffset } = {}) {
  const storage = new Map(
      savedOffset === undefined ? [] : [['higherweb.lyricOffset.v1', savedOffset]],
    ),
    delays = [],
    frames = [],
    images = [],
    rafs = new Map();
  let rafId = 0;
  /* 最小 DOM/音频元素替身：只实现 app.js 使用的 API；不负责浏览器布局和真实音频解码。 */
  class Element extends EventTarget {
    constructor() {
      super();
      this.style = { setProperty() {} };
      this.dataset = {};
      const classes = new Set();
      this.classList = {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
        toggle: (c, force) => {
          const next = force ?? !classes.has(c);
          if (next) classes.add(c);
          else classes.delete(c);
          return next;
        },
      };
      this.children = [];
      this.value = '';
      this.hidden = false;
      this.paused = true;
      this.duration = 240;
      this.currentTime = 0;
    }
    set src(value) {
      this.source = value;
      this.complete = true;
      this.naturalWidth = 500;
      queueMicrotask(() => this.onload?.());
    }
    get src() {
      return this.source || '';
    }
    decode() {
      return Promise.resolve();
    }
    set textContent(value) {
      this.text = value;
      if (this.id === 'flashTitle') frames.push(value);
    }
    get textContent() {
      return this.text || '';
    }
    querySelector(selector) {
      this.parts ??= {};
      return (this.parts[selector] ??= new Element());
    }
    append(...rows) {
      this.children.push(...rows);
    }
    replaceChildren(...rows) {
      this.children = rows;
    }
    add(row) {
      this.children.push(row);
    }
    setAttribute() {}
    removeAttribute(name) {
      if (name === 'src') {
        this.source = '';
        this.complete = false;
      }
    }
    before() {}
    load() {}
    pause() {
      this.paused = true;
      this.onpause?.();
    }
    play() {
      this.paused = false;
      queueMicrotask(() => {
        this.dispatchEvent(new Event('playing'));
        this.onplaying?.();
      });
      return Promise.resolve();
    }
    showModal() {
      this.open = true;
    }
    close() {
      this.open = false;
    }
    focus() {}
  }
  const elements = new Map(),
    cards = Array.from({ length: 9 }, () => new Element());
  const get = (id) => {
    if (!elements.has(id)) {
      const e = new Element();
      e.id = id;
      elements.set(id, e);
    }
    return elements.get(id);
  };
  /* 隔离执行上下文：注入模拟浏览器 API，让测试直接检查真实脚本中的状态和函数。 */
  const context = vm.createContext({
    console,
    AbortController,
    DOMException,
    Event,
    Image: class {
      set src(value) {
        this.source = value;
        images.push(this);
        if (autoImages) queueMicrotask(() => this.onload?.());
      }
      get src() {
        return this.source;
      }
      decode() {
        return Promise.resolve();
      }
    },
    Option: class {},
    performance,
    queueMicrotask,
    crypto: { randomUUID: () => "12345678-1234-1234-1234-123456789012" },
    setTimeout: (fn, ms) => {
      delays.push(ms);
      return ms >= 10000 ? 0 : setTimeout(fn, 0);
    },
    clearTimeout,
    matchMedia: () => ({ matches: false }),
    location: { protocol: 'http:' },
    requestAnimationFrame: (fn) => {
      rafs.set(++rafId, fn);
      return rafId;
    },
    cancelAnimationFrame: (id) => rafs.delete(id),
    localStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
    },
    document: {
      getElementById: get,
      querySelectorAll: (s) => (s === '.card' ? cards : []),
      querySelector: (s) => (s === 'dialog[open]' ? null : get(s)),
      body: get('body'),
      addEventListener() {},
      createElement: () => new Element(),
    },
    fetch: async () => ({ ok: true, json: async () => ({ ready: true, user: null }) }),
  });
  /* 执行项目当前 app.js 后返回查询工具；run 可在同一上下文读写内部状态，便于验证竞态。 */
  vm.runInContext(script, context);
  return {
    run: (code) => vm.runInContext(code, context),
    elements,
    get,
    cards,
    delays,
    frames,
    storage,
    images,
    rafs,
    stepFrame: () => {
      const pending = [...rafs.values()];
      rafs.clear();
      for (const fn of pending) fn();
    },
  };
}
/* 等待一轮异步回调，使图片解码或事件微任务先完成，再断言最终状态。 */
const flush = () => new Promise((resolve) => setImmediate(resolve));
test('单文件语法正确并且主画廊永久只有九张卡片', () => {
  assert.equal((html.match(/<figure\b/g) || []).length, 9);
  assert.doesNotThrow(() => harness());
});
test('同步开关默认开启并持久化；账号退出取消排队历史', async () => {
  const h = harness();
  assert.equal(h.get('historySync').checked, true);
  h.run("$('historySync').checked=false;$('historySync').onchange()");
  assert.equal(h.storage.get('higherweb.historySync.v1'), 'false');
  assert.equal(h.run('listening.enabled'), false);
  h.run("$('historySync').checked=true;$('historySync').onchange();songs=[{id:'a',hash:'a'.repeat(32)}];listening.begin(songs[0],audio)");
  const pending = h.run("listening.send({songId:'a',hash:'a'.repeat(32),playbackId:listening.round.playbackId}).catch(e=>e.name)");
  h.run('listening.cancelPending();stopAudio()');
  assert.equal(await pending, 'AbortError');
});
test('停止后继续仅检查尚未完成的歌曲，不调用播放或历史接口', async () => {
  const h = harness();
  await flush();
  h.run("rawTracks=[{id:'a',hash:'a',title:'A'},{id:'b',hash:'b',title:'B',cover:'https://example.com/b.jpg'}];checkedIds.add('a');songs=[{id:'a',title:'A'}];globalThis.requested=[];globalThis.fetch=async(url)=>{requested.push(url);return {ok:true,json:async()=>({state:'allowed',playbackState:'allowed',playable:true})}}");
  await h.run('checkAll()');
  assert.equal(h.run('JSON.stringify(requested)'), '["/api/inspect?track=b"]');
  assert.equal(h.run('songs.length'), 2);
});
test('全量检查完成后顶部重新检查会真正请求，并刷新一次账号权益', async () => {
  const h = harness();
  await flush();
  h.run("rawTracks=[{id:'a',hash:'a',title:'A',cover:'https://example.com/a.jpg'},{id:'b',hash:'b',title:'B',cover:'https://example.com/b.jpg'}];checkedIds.add('a');checkedIds.add('b');globalThis.requested=[];globalThis.fetch=async(url)=>{requested.push(url);return {ok:true,json:async()=>({state:'allowed',playbackState:'allowed',playable:true})}};$('check').onclick()");
  for (let n = 0; n < 8; n++) await flush();
  assert.equal(h.run('JSON.stringify(requested)'), '["/api/inspect?track=a&fresh=1&accountFresh=1","/api/inspect?track=b&fresh=1"]');
});

test('已达标历史排在慢检查后，正常下一首不会取消原歌曲的提交', async () => {
  const h = harness();
  await flush();
  h.run("songs=[{id:'a',title:'A',hash:'a'.repeat(32)},{id:'b',title:'B',hash:'b'.repeat(32)}];index=0;listening.begin(songs[0],audio);globalThis.reports=[];globalThis.fetch=(url,options)=>url.includes('slow')?new Promise(resolve=>globalThis.release=resolve):Promise.resolve({ok:true,json:async()=>{if(url.includes('report_history'))reports.push(JSON.parse(options.body));return {ok:true,accepted:true}}});playCurrent=async()=>{}");
  const blocker = h.run("request('inspect?track=slow','POST')");
  await flush();
  const report = h.run("listening.send({songId:'a',hash:'a'.repeat(32),playbackId:listening.round.playbackId})");
  h.run("goTo(1,false);release({ok:true,json:async()=>({})})");
  await blocker;
  await report;
  assert.equal(h.run('reports.length'), 1);
  assert.equal(h.run('reports[0].songId'), 'a');
  assert.equal(h.run('index'), 1);
});

test('8秒中断后自动恢复保留轮次和累计时间，再听8秒只上报一次', async () => {
  const h = harness();
  await flush();
  h.run("songs=[{id:'a',title:'A',hash:'a'.repeat(32)}];index=0;loadedId='a';audio.paused=false;audio.readyState=4;audio.currentTime=8;globalThis.clock=0;listening.now=()=>clock;listening.begin(songs[0],audio);listening.round.seconds=8;globalThis.originalRound=listening.round;globalThis.reports=[];loadSource=async()=>{audio.paused=false;audio.currentTime=0};globalThis.fetch=async(url,options)=>({ok:true,json:async()=>{if(url.includes('report_history')){reports.push(JSON.parse(options.body));return {ok:true,accepted:true}}return {state:'allowed',playbackState:'allowed',url:'/api/audio?ticket='+'a'.repeat(48),expectedDuration:240}}})");
  await h.run('playCurrent(8,true)');
  assert.equal(h.run('listening.round === originalRound'), true);
  assert.equal(h.run('listening.round.seconds'), 8);
  assert.equal(h.run('audio.currentTime'), 8);
  for (let n = 0; n < 8; n++) h.run('clock+=1000;audio.currentTime+=1;listening.tick(audio)');
  for (let n = 0; n < 4; n++) await flush();
  assert.equal(h.run('reports.length'), 1);
  assert.equal(h.run('reports[0].playbackId === originalRound.playbackId'), true);
  await h.run('playCurrent(16,true)');
  for (let n = 0; n < 8; n++) h.run('clock+=1000;audio.currentTime+=1;listening.tick(audio)');
  await flush();
  assert.equal(h.run('reports.length'), 1);
});

test('自动定位不算用户拖动，真实拖动仍永久取消本轮', () => {
  const h = harness();
  h.run("songs=[{id:'a',hash:'a'.repeat(32)}];audio.paused=false;listening.begin(songs[0],audio);automaticSeek={version:playVersion,target:8};audio.currentTime=8;audio.dispatchEvent(new Event('seeking'))");
  assert.equal(h.run('listening.round.invalid'), false);
  h.run("automaticSeek=null;audio.currentTime=60;audio.dispatchEvent(new Event('seeking'))");
  assert.equal(h.run('listening.round.invalid'), true);
});
test('中途故障最多恢复一次并携带进度，切歌后旧恢复任务失效', async () => {
  const h = harness();
  h.run("songs=[{id:'a'}];loadedId='a';audio.paused=false;audio.currentTime=27;globalThis.restores=[];playCurrent=async(...args)=>restores.push(args);scheduleRecovery(true)");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.run('JSON.stringify(restores)'), '[[27,true]]');
  h.run('scheduleRecovery(true)');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.run('restores.length'), 1);
  h.run('recoveryAttempts=0;scheduleRecovery(true);playVersion++');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.run('restores.length'), 1);
});
test('清洗歌名歌手与网络封面；待确认和无音源不能进入画廊', () => {
  const h = harness();
  const track = h.run(
    "cleanTrack({id:'a',title:'Aimer - Brave Shine.mp3',cover:'http://example.com/{size}.jpg'},{url:'https://example.com/a',expectedDuration:234})",
  );
  assert.equal(track.title, 'Brave Shine');
  assert.equal(track.artist, 'Aimer');
  assert.equal(track.cover, 'https://example.com/500.jpg');
  assert.equal(
    h.run(
      "isPlayable({state:'unknown',playbackState:'unknown'},{audio:'https://example.com/a'})",
    ),
    false,
  );
  assert.equal(
    h.run("isPlayable({state:'allowed',playbackState:'allowed'},{audio:''})"),
    false,
  );
});
test('蒙太奇以110毫秒呈现十八帧，含定格淡出总时长2.8秒，预加载最多200毫秒', async () => {
  const h = harness();
  h.run(
    "songs=Array.from({length:20},(_,i)=>({id:String(i),title:'歌曲'+i,artist:'歌手',cover:'',audio:'https://example.com/a'}));playCurrent=async()=>{};",
  );
  await h.run('montageTo(19)');
  assert.equal(h.delays.filter((x) => x === 110).length, 18);
  assert.ok(h.delays.includes(220));
  assert.ok(h.delays.includes(600));
  assert.ok(h.delays.includes(200));
  assert.equal(
    h.delays
      .filter((ms) => [110, 220, 600].includes(ms))
      .reduce((sum, ms) => sum + ms, 0),
    2800,
  );
  assert.equal(h.run('index'), 19);
  assert.equal(h.run('flashing'), false);
  assert.equal(h.get('montage').hidden, true);
  // 路径包含目标曲且最多 18 帧；目标曲不会重复显示两次。
  assert.equal(h.frames.filter((x) => /^歌曲/.test(x)).length, 18);
  assert.equal(h.cards.length, 9);
});
test('自定义背景按稳定歌曲 ID 保存文件名，不存储图片数据，恢复默认会移除映射', async () => {
  const h = harness();
  h.run("songs=[{id:'a',title:'A'},{id:'b',title:'B'}];saveBackground('风景 图.jpg');");
  assert.equal(JSON.parse(h.storage.get('higherweb.backgrounds.v1')).a, '风景 图.jpg');
  h.run("index=1;saveBackground('second.webp');index=0;saveBackground('');");
  const map = JSON.parse(h.storage.get('higherweb.backgrounds.v1'));
  assert.equal(map.a, undefined);
  assert.equal(map.b, 'second.webp');
  assert.equal(h.run("safeImageName('../secret.png')"), false);
});
test('封面不构造第三方地址；背景文件接口拒绝路径穿越和可执行图片类型', async () => {
  assert.equal(coverUrl('javascript:bad'), '');
  assert.equal(coverUrl('http://example.com/{size}.jpg'), 'https://example.com/500.jpg');
  assert.equal(await backgroundFile('../secret.png'), null);
  assert.equal(await backgroundFile('script.svg'), null);
});

test('从自定义背景歌曲切到未设置背景的歌曲时恢复深色，不把专辑封面铺满背景', async () => {
  const h = harness();
  h.storage.set('higherweb.backgrounds.v1', JSON.stringify({ a: '风景 图.jpg' }));
  h.run(
    "songs=[{id:'a',title:'A',cover:'https://example.com/a.jpg'},{id:'b',title:'B',cover:'https://example.com/b.jpg'}];index=0;",
  );
  await h.run('setBackground()');
  const layers = ['bgA', 'bgB'].map((id) => h.get(id));
  assert.match(
    layers.find((e) => e.classList.contains('active')).style.backgroundImage,
    /\/Image169\//,
  );
  h.run('index=1;renderGallery()');
  await flush();
  assert.equal(layers.filter((e) => e.classList.contains('active')).length, 1);
  assert.equal(
    layers.find((e) => e.classList.contains('active')).style.backgroundImage,
    'none',
  );
  for (const id of ['bgA', 'bgB'])
    assert.doesNotMatch(h.get(id).style.backgroundImage, /example\.com/);
});

test('预加载首尾相邻封面；快速换绑时清掉旧图，迟到的旧请求不能覆盖新图', async () => {
  const h = harness({ autoImages: false });
  h.run(
    "songs=Array.from({length:3},(_,i)=>({id:String(i),title:'歌曲'+i,cover:'https://example.com/'+i+'.jpg'}));index=2;renderGallery();renderGallery();",
  );
  for (const n of [0, 1, 2])
    assert.equal(
      h.images.filter((x) => x.src === `https://example.com/${n}.jpg`).length,
      1,
    );
  const img = h.get('probe');
  img.src = 'old.jpg';
  img.classList.add('is-loaded');
  h.run("paintCover($('probe'),'https://example.com/old-late.jpg')");
  assert.equal(img.src, '');
  assert.equal(img.classList.contains('is-loaded'), false);
  h.run("paintCover($('probe'),'https://example.com/new.jpg')");
  h.images.find((x) => x.src.endsWith('/old-late.jpg')).onload();
  await flush();
  assert.equal(img.src, '');
  h.images.find((x) => x.src.endsWith('/new.jpg')).onload();
  await flush();
  assert.equal(img.src, 'https://example.com/new.jpg');
  assert.equal(img.classList.contains('is-loaded'), true);
});

test('封面下载失败保持占位并回退，不重新显示旧图片', async () => {
  const h = harness({ autoImages: false }),
    img = h.get('probe');
  img.src = 'old.jpg';
  h.run("paintCover($('probe'),'https://example.com/broken.jpg')");
  h.images.find((x) => x.src.endsWith('broken.jpg')).onerror();
  await flush();
  assert.equal(img.src, '');
  assert.equal(img.classList.contains('is-loaded'), false);
  h.images.find((x) => x.src.startsWith('data:')).onload();
  await flush();
  assert.match(img.src, /^data:image\/svg\+xml/);
  assert.equal(img.classList.contains('is-loaded'), true);
});

test('最后到第一首、第一首到最后都按指定方向平移，沿用相邻卡片且始终九张', async () => {
  const h = harness();
  h.run(
    "songs=Array.from({length:3},(_,i)=>({id:String(i),title:'歌曲'+i,cover:''}));index=2;renderGallery();playCurrent=async()=>{};",
  );
  const next = h.run('cards[5]');
  await h.run('goTo(wrapIndex(index+1),true,1)');
  assert.equal(h.run('index'), 0);
  assert.equal(h.run('cards[4]'), next);
  assert.equal(h.get('previous').disabled, false);
  assert.equal(h.get('next').disabled, false);
  const previous = h.run('cards[3]');
  await h.run('goTo(wrapIndex(index-1),true,-1)');
  assert.equal(h.run('index'), 2);
  assert.equal(h.run('cards[4]'), previous);
  assert.equal(h.cards.length, 9);
  assert.equal(h.run('cards[5]').querySelector('h1').textContent, '歌曲0');
});

test('顺序自然结束回到第一首；单曲循环仍重播当前曲；空歌单安全停止', async () => {
  const h = harness();
  h.run(
    "songs=[{id:'a',title:'A'},{id:'b',title:'B'}];index=1;playCurrent=async()=>{};advance(1,true);",
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.run('index'), 0);
  h.run("$('mode').value='single';advance(1,true)");
  assert.equal(h.run('index'), 0);
  h.run('songs=[];advance(-1);renderGallery()');
  assert.equal(h.run('wrapIndex(-1)'), -1);
  assert.equal(h.get('previous').disabled, true);
});

test('LRC 正负毫秒偏移与全局秒偏移叠加，逐帧同步并支持往回拖动', () => {
  const h = harness();
  h.run(
    "const parsed=parseLrc('[offset:+250]\\n[00:01.00]第一句\\n[00:02.00]第二句');lyricLines=parsed.lines;lrcOffset=parsed.offset;audio.currentTime=.9;audio.paused=false;startLyricSync();startLyricSync();",
  );
  assert.equal(h.rafs.size, 1);
  assert.equal(h.get('lyricCurrent').textContent, '♪');
  h.run('audio.currentTime=1.01');
  h.stepFrame();
  assert.equal(h.get('lyricCurrent').textContent, '第一句');
  h.run('audio.currentTime=2.01');
  h.stepFrame();
  assert.equal(h.get('lyricCurrent').textContent, '第二句');
  h.run('audio.currentTime=.1;audio.onseeked()');
  assert.equal(h.get('lyricCurrent').textContent, '♪');
  assert.equal(h.run("parseLrc('[offset:-120]\\n[00:01]句子').offset"), -0.12);
  h.run('audio.pause()');
  assert.equal(h.rafs.size, 0);
  h.run('audio.paused=false;startLyricSync();audio.ended=true');
  h.stepFrame();
  assert.equal(h.rafs.size, 0);
});

test('微调按钮每次恰好 0.1 秒，保存后刷新恢复，损坏设置使用默认值', () => {
  const h = harness({ savedOffset: '-0.7' });
  assert.equal(h.run('lyricOffset'), -0.7);
  h.run('lyricPlus.onclick();lyricPlus.onclick();lyricMinus.onclick()');
  assert.equal(h.run('lyricOffset'), -0.6);
  assert.equal(h.run('lyricOffsetOutput.textContent'), '-0.6s');
  assert.equal(h.storage.get('higherweb.lyricOffset.v1'), '-0.6');
  assert.equal(
    harness({ savedOffset: h.storage.get('higherweb.lyricOffset.v1') }).run(
      'lyricOffset',
    ),
    -0.6,
  );
  assert.equal(harness({ savedOffset: 'broken' }).run('lyricOffset'), -0.2);
});

test('图片和音频仍在加载时连续切歌立即更新索引，九节点固定并预取窗口外围', () => {
  const h = harness({ autoImages: false });
  h.run(
    "songs=Array.from({length:30},(_,i)=>({id:String(i),title:'歌曲'+i,cover:'https://example.com/'+i+'.jpg'}));index=10;renderGallery();playCurrent=async()=>{};loadingAudio=true;advance(1);advance(1);advance(-1);",
  );
  assert.equal(h.run('index'), 11);
  assert.equal(h.run('cards[4]').querySelector('h1').textContent, '歌曲11');
  assert.equal(h.cards.length, 9);
  for (const n of [4, 5, 14, 15, 16])
    assert.ok(h.images.some((x) => x.src === `https://example.com/${n}.jpg`));
  assert.equal(h.run('sliding'), false);
});

test('切换沉浸模式不改变音频地址、播放状态或进度，唱臂随暂停联动', () => {
  const h = harness();
  h.run(
    "audio.src='https://example.com/song.mp3';audio.currentTime=37;audio.paused=false;toggleImmersive();",
  );
  assert.equal(h.run("document.body.classList.contains('immersive')"), true);
  assert.equal(h.get('audio').src, 'https://example.com/song.mp3');
  assert.equal(h.get('audio').currentTime, 37);
  assert.equal(h.get('audio').paused, false);
  h.run('audio.onplay()');
  assert.equal(
    h.run("document.querySelector('.record-deck').classList.contains('is-playing')"),
    true,
  );
  h.run('audio.pause();toggleImmersive()');
  assert.equal(
    h.run("document.querySelector('.record-deck').classList.contains('is-playing')"),
    false,
  );
  assert.equal(h.run("document.body.classList.contains('immersive')"), false);
  assert.equal(h.get('audio').currentTime, 37);
});

test('近距离搜索平移后合并播放，不重复启动旧任务', async () => {
  const h = harness();
  h.run(
    "songs=[{id:'a',title:'A'},{id:'b',title:'B'}];let calls=0;playCurrent=async()=>{calls++};playTimer=setTimeout(()=>playCurrent(),120);",
  );
  await h.run('montageTo(1)');
  assert.equal(h.run('calls'), 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.run('calls'), 1);
  assert.equal(h.run('index'), 1);
});

test('沉浸标题与歌手在右侧更新，同源音源凭据可清洗且拒绝任意相对路径', () => {
  const h = harness();
  h.run("songs=[{id:'a',title:'Brave Shine',artist:'Aimer'}];renderGallery()");
  assert.equal(h.get('immersiveTitle').textContent, 'Brave Shine');
  assert.equal(h.get('immersiveArtist').textContent, 'Aimer');
  const ticket = '/api/audio?ticket=' + 'a'.repeat(48);
  assert.equal(h.run(`cleanTrack({id:'a'},{url:'${ticket}'}).audio`), ticket);
  assert.equal(h.run("cleanTrack({id:'a'},{url:'/somewhere'}).audio"), '');
  assert.match(html, /<svg\s+class="tonearm"/);
  assert.match(html, /id="musicSpectrum"/);
});
