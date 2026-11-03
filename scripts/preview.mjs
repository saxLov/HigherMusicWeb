/* 离线界面验证专用。不会连接酷狗，不使用任何真实凭据，不计入真实听歌记录。 */
import { createMusicServer } from '../server.mjs';
import { normalizeTrack } from '../lib/provider.mjs';
import { fileURLToPath } from 'node:url';

export function createPreview() {
  const calls = [];
  const rows = Array.from({ length: 28 }, (_, n) => ({
    album_audio_id: n + 1001, hash: (n + 1).toString(16).padStart(32, '0'),
    name: n < 2 ? '同名测试曲' : `测试歌曲 ${n + 1}`, singername: `测试歌手 ${n % 3 + 1}`,
    duration: 60, album_id: n + 2001,
  }));
  const accepted = (track) => {
    const n = Number(track.albumAudioId) - 1001;
    if (n < 24) return { state: 'allowed', eligibilityState: 'allowed', eligible: true,
      entitlement: 'free', reason: '平台确认免费', entitlementReason: '平台确认免费',
      playbackState: 'allowed', playbackReason: '完整音源', expectedDuration: 60,
      url: 'https://offline.invalid/demo.wav', urls: ['https://offline.invalid/demo.wav'] };
    return { state: n === 27 ? 'unavailable' : 'unknown', eligibilityState: n === 25 ? 'allowed' : n === 27 ? 'unavailable' : 'unknown',
      eligible: n === 25, entitlement: n === 25 ? 'purchased' : 'unknown',
      reason: n === 25 ? '已购单曲' : n === 27 ? '平台未上架' : '权益待确认',
      playbackState: n === 26 ? 'blocked' : 'unknown', playbackReason: n === 26 ? '仅允许试听' : '音源暂不可用' };
  };
  const request = async (s, name, params = {}) => {
    calls.push({ name, params });
    switch (name) {
      case 'login_qr_key': return { data: { key: 'offline' } };
      case 'login_qr_create': return { data: { base64: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="white"/><text x="20" y="100">OFFLINE PREVIEW</text></svg>') } };
      case 'login_qr_check': return { data: { status: 4, userid: '123', token: 'offline-only', nickname: '离线测试' } };
      case 'user_playlist': return { data: { list: [{ listid: 1, name: '离线测试歌单', count: rows.length }], total: 1 } };
      case 'playlist_track_all_new': return { data: { list: rows, total: rows.length } };
      case 'album_detail': return { data: [] };
      case 'search_lyric': return { candidates: [{ id: 1, accesskey: 'offline' }] };
      case 'lyric': return { decodeContent: '[00:00]离线测试歌词\n[00:05]暂停与拖动不应误报\n[00:15]真实播放超过十五秒\n[00:30]每轮只提交一次' };
      case 'playhistory_upload': return { status: 1 };
      default: throw new Error('离线预览不支持此操作');
    }
  };
  const rate = 8000, samples = rate * 60, wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  const server = createMusicServer({ request, inspectAccess: async (_, track) => accepted(track),
    adapters: async (name) => name === 'access' ? { checkAccess: async (_, track) => accepted(track) } : { normalizeTrack },
    audioProxy: async (req, res, s, ticket) => {
      if (!s.user || !s.media?.has(ticket)) { res.writeHead(403); res.end(); return; }
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      const start = match ? Number(match[1]) : 0;
      const end = match && match[2] ? Math.min(Number(match[2]), wav.length - 1) : wav.length - 1;
      res.writeHead(match ? 206 : 200, { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1, ...(match ? { 'Content-Range': `bytes ${start}-${end}/${wav.length}` } : {}) });
      res.end(wav.subarray(start, end + 1));
    },
  });
  return { server, calls, rows };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server } = createPreview();
  server.listen(3219, '127.0.0.1', () => console.log('离线预览（不连接酷狗）：http://127.0.0.1:3219'));
}
