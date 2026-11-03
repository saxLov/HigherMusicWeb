/* 业务 API 单队列；播放/歌词优先，批量检查在每首之间让出队列。 */
(function (root) {
  function createApiClient(base = '') {
    const pending = [];
    let running = false;
    async function drain() {
      if (running) return;
      running = true;
      try {
        while (pending.length) {
          pending.sort((a, b) => b.priority - a.priority);
          const job = pending.shift();
          if (!job.valid()) { job.reject(new DOMException('任务已失效', 'AbortError')); continue; }
          const control = new AbortController();
          const timer = setTimeout(() => control.abort(), 180000);
          try {
            const response = await fetch(base + '/api/' + job.route, {
              method: job.method, credentials: 'include', signal: control.signal,
              ...(job.body === undefined ? {} : {
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job.body),
              }),
            });
            let data;
            try { data = await response.json(); }
            catch { throw new Error('接口返回格式无效'); }
            if (!response.ok) throw new Error(data.error || `请求失败 ${response.status}`);
            job.resolve(data);
          } catch (error) {
            job.reject(error.name === 'AbortError' ? new Error('平台响应超时，请重试') : error);
          } finally { clearTimeout(timer); }
        }
      } finally { running = false; }
    }
    return (route, method = 'GET', valid = () => true, options = {}) => new Promise((resolve, reject) => {
      const priority = options.priority ?? (/^(?:play\?|lyrics\?|logout)/.test(route) ? 10 : 0);
      pending.push({ route, method, valid, body: options.body, priority, resolve, reject });
      queueMicrotask(drain);
    });
  }
  root.HigherApi = { createApiClient };
})(globalThis);
