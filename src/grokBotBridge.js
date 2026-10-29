'use strict';
// Grok Bot 對話橋接：
//  送出：主程序以 HTTP POST 呼叫 Grok Bot routine 的 webhook（Authorization: Bearer <key>），2xx 只代表「已開始執行」。
//  收回：Grok Bot 執行完把 {conversation_id,message_id,reply,ok} 發佈到 ntfy 主題；這裡訂閱 /json 串流
//        （串流連不上時改成每幾秒 poll），依 message_id 把回覆交回等待中的請求。
// 只用 Node 內建（global fetch／crypto），金鑰絕不寫進記錄或錯誤訊息。
const crypto = require('node:crypto');

const DEFAULT_TOPIC = '';
const DEFAULT_SERVER = 'https://ntfy.sh';
const REPLY_TIMEOUT_MS = 6 * 60 * 1000;
const POST_TIMEOUT_MS = 30 * 1000;
const HISTORY_LIMIT = 20;          // 最多帶最近 20 則（使用者＋助理）訊息
const HISTORY_CHARS = 4000;        // 每則歷史訊息最多字元
const MESSAGE_CHARS = 200000;      // 本次訊息最多字元
const BODY_LIMIT = 900 * 1024;     // webhook 主體上限（保守低於 1 MiB）
const ATTACHMENT_LIMIT = 5 * 1024 * 1024;
const REPLY_LIMIT = 5 * 1024 * 1024;
const LINE_LIMIT = 6 * 1024 * 1024;
const PENDING_STATUS = 'Grok Bot 處理中…（約需數十秒到數分鐘）';

function isLoopback(host) { return /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(String(host || '')); }
function checkUrl(raw, label) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw Object.assign(new Error(`${label}不是有效的網址`), { code: 'GROKBOT_BAD_CONFIG' }); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.hostname))) throw Object.assign(new Error(`${label}必須是 https:// 開頭的網址`), { code: 'GROKBOT_BAD_CONFIG' });
  if (u.username || u.password) throw Object.assign(new Error(`${label}不可包含帳號或密碼`), { code: 'GROKBOT_BAD_CONFIG' });
  return u;
}
// 使用者可能整行貼上「Authorization: Bearer xxx」：只留下金鑰本體
function cleanKey(raw) {
  return String(raw || '').trim().replace(/^authorization\s*:\s*/i, '').replace(/^bearer\s+/i, '').replace(/\s+/g, '');
}
function normalizeConfig(cfg = {}) {
  return {
    webhookUrl: String(cfg.webhookUrl || '').trim(),
    webhookKey: cleanKey(cfg.webhookKey),
    ntfyServer: (String(cfg.ntfyServer || '').trim() || DEFAULT_SERVER).replace(/\/+$/, ''),
    ntfyTopic: String(cfg.ntfyTopic || '').trim() || DEFAULT_TOPIC,
    allowPublicReplies: cfg.allowPublicReplies === true,
  };
}
const SETUP_HINT = '請到「設定 → Grok Bot」貼上 Webhook URL 與 Webhook Key（在 Grok Bot App 的 routine「王品工作台 Grok Bot 對話橋接」面板 Webhook 區塊可複製）；或先用「開啟 Grok Bot 桌面版」。';
function validateConfig(raw, { requireWebhook = true } = {}) {
  const cfg = normalizeConfig(raw);
  if (requireWebhook && (!cfg.webhookUrl || !cfg.webhookKey)) {
    const missing = [!cfg.webhookUrl && 'Webhook URL', !cfg.webhookKey && 'Webhook Key'].filter(Boolean).join(' 與 ');
    throw Object.assign(new Error(`尚未設定 Grok Bot 的 ${missing}。${SETUP_HINT}`), { code: 'GROKBOT_NOT_CONFIGURED' });
  }
  if (cfg.webhookUrl) checkUrl(cfg.webhookUrl, 'Webhook URL ');
  if (cfg.webhookKey && !/^[\x21-\x7e]{8,4096}$/.test(cfg.webhookKey)) throw Object.assign(new Error('Webhook Key 格式不正確（應為一串沒有空白的英數字元）'), { code: 'GROKBOT_BAD_CONFIG' });
  checkUrl(cfg.ntfyServer, 'ntfy 伺服器');
  if (new URL(cfg.ntfyServer).hostname.toLowerCase() === 'ntfy.sh' && !cfg.allowPublicReplies) throw Object.assign(new Error('使用公開 ntfy 回覆頻道前，請明確同意公開回覆傳輸。'), { code: 'GROKBOT_BAD_CONFIG' });
  if (!/^[-_A-Za-z0-9]{1,64}$/.test(cfg.ntfyTopic)) throw Object.assign(new Error('ntfy 主題只能包含英數字、- 或 _（最多 64 字）'), { code: 'GROKBOT_BAD_CONFIG' });
  return cfg;
}

function clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n…（已截斷，原長 ${s.length} 字）` : s;
}
function buildHistory(messages = [], { limit = HISTORY_LIMIT, chars = HISTORY_CHARS } = {}) {
  return (Array.isArray(messages) ? messages : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && String(m.text ?? m.content ?? '').trim())
    .slice(-limit)
    .map(m => ({ role: m.role, content: clip(m.text ?? m.content, chars) }));
}
function buildBody({ conversationId, messageId, message, history = [], workspace = '' }) {
  const payload = { conversation_id: String(conversationId || ''), message_id: messageId, message: clip(message, MESSAGE_CHARS), history: [...history], workspace: String(workspace || '').slice(0, 32768) };
  let body = JSON.stringify(payload);
  while (Buffer.byteLength(body) > BODY_LIMIT && payload.history.length) { payload.history.shift(); body = JSON.stringify(payload); }
  if (Buffer.byteLength(body) > BODY_LIMIT) { payload.message = clip(payload.message, Math.floor(BODY_LIMIT / 4)); body = JSON.stringify(payload); }
  if (Buffer.byteLength(body) > BODY_LIMIT) throw new Error('Grok Bot 訊息超過大小上限');
  return body;
}
// Existing Grok Bot routine uses Authorization: Bearer <key>.
function authHeaders(key, body) {
  return { Authorization: `Bearer ${key}` };
}
function redact(text, key) {
  let s = String(text || '');
  if (key) s = s.split(key).join('***');
  return s.replace(/Bearer\s+[\x21-\x7e]+/gi, 'Bearer ***');
}
function webhookError(status, detail) {
  const reason = status === 401 || status === 403 ? 'Webhook Key 不正確或已更換，請到 routine 面板重新複製 key'
    : status === 404 ? 'Webhook URL 不正確，或 routine 已刪除'
      : status === 409 || status === 423 ? 'routine 目前已暫停，請在 Grok Bot App 恢復'
        : status === 413 ? '訊息太長，請縮短後再送出'
          : status === 429 ? '呼叫太頻繁（rate limit），請稍後再試'
            : status >= 500 ? 'Grok Bot 服務暫時無法使用，請稍後再試' : '請確認 routine 沒有暫停、URL 與 key 是最新的';
  return Object.assign(new Error(`Grok Bot 沒有開始執行（HTTP ${status}）：${reason}。${detail ? `\n伺服器回應：${detail}` : ''}`), { code: 'GROKBOT_WEBHOOK', status });
}
// 把外部 signal 與逾時合成一個 AbortSignal（不依賴 AbortSignal.any）
function linkedSignal(signal, ms) {
  const controller = new AbortController();
  const timer = ms ? setTimeout(() => controller.abort(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), ms) : null;
  const onAbort = () => controller.abort(signal.reason);
  if (signal) { if (signal.aborted) controller.abort(signal.reason); else signal.addEventListener('abort', onAbort, { once: true }); }
  return { signal: controller.signal, done: () => { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', onAbort); } };
}
const abortError = () => Object.assign(new Error('已停止'), { name: 'AbortError' });
function ensureActive(signal) { if (signal?.aborted) throw signal.reason || abortError(); }
function awaitActive(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal?.removeEventListener('abort', abort); reject(signal.reason || abortError()); };
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(signal.reason || abortError()); else resolve(value);
    }, error => { signal?.removeEventListener('abort', abort); reject(error); });
    if (signal?.aborted) abort();
  });
}
// Every response is consumed under the same abort deadline as its headers.
async function readBounded(res, limit, signal) {
  ensureActive(signal);
  const length = Number(res.headers?.get?.('content-length'));
  if (length > limit) { res.body?.cancel?.().catch(() => {}); throw new Error('回應超過大小上限'); }
  if (!res.body) return '';
  if (typeof res.body.getReader !== 'function') throw new Error('回應沒有可讀取的串流');
  const reader = res.body.getReader();
  let total = 0; const chunks = [];
  try {
    for (;;) {
      ensureActive(signal);
      const { value, done } = await reader.read();
      ensureActive(signal);
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error('回應超過大小上限');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally { reader.cancel().catch(() => {}); }
}
const sleep = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, { once: true });
});

// ntfy 回覆的 message 欄位應是 JSON 字串；寬鬆處理：前後多了文字時取第一個 { 到最後一個 }
function parseReplyPayload(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  for (const candidate of [s, s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)]) {
    if (!candidate.startsWith('{')) continue;
    try { const v = JSON.parse(candidate); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* 試下一種 */ }
  }
  return null;
}

class Subscriber {
  constructor({ server, topic, fetchImpl, pollMs, idleMs, mode, log, onIdle }) {
    Object.assign(this, { server, topic, fetchImpl, pollMs, idleMs, mode, log, onIdle });
    this.waiters = new Map();
    this.seen = new Set();
    this.lastId = '';
    this.controller = null;
    this.readyWaiters = [];
    this.ready = false;
  }
  sinceParam() {
    if (this.lastId) return this.lastId;
    const times = [...this.waiters.values()].map(w => w.since);
    return String(times.length ? Math.min(...times) : Math.floor(Date.now() / 1000) - 10);
  }
  markReady() { this.ready = true; for (const r of this.readyWaiters.splice(0)) r(); }
  whenReady(ms) {
    if (this.ready) return Promise.resolve();
    return new Promise(resolve => { const t = setTimeout(resolve, ms); this.readyWaiters.push(() => { clearTimeout(t); resolve(); }); });
  }
  wait({ messageId, conversationId, signal, timeoutMs, since }) {
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => {
        const w = this.waiters.get(messageId); if (!w) return;
        clearTimeout(w.timer); signal?.removeEventListener('abort', w.onAbort);
        this.waiters.delete(messageId);
        if (!this.waiters.size) this.stop();
        fn(value);
      };
      const w = { conversationId: String(conversationId || ''), since, resolve: v => finish(resolve, v), reject: e => finish(reject, e) };
      w.onAbort = () => w.reject(abortError());
      w.timer = setTimeout(() => w.reject(Object.assign(new Error(`Grok Bot 在 ${Math.round(timeoutMs / 60000) || 1} 分鐘內沒有回覆。訊息已送出、routine 可能仍在執行或已失敗；請到 Grok Bot App 查看該 routine 的執行紀錄，或稍後重新送出。`), { code: 'GROKBOT_TIMEOUT' })), timeoutMs);
      this.waiters.set(messageId, w);
      if (signal) { if (signal.aborted) return w.onAbort(); signal.addEventListener('abort', w.onAbort, { once: true }); }
      this.start();
    });
  }
  cancel(messageId, error) { this.waiters.get(messageId)?.reject(error || abortError()); }
  start() {
    if (this.controller && !this.controller.signal.aborted) return;
    this.ready = false; this.lastId = '';
    const controller = this.controller = new AbortController();
    this.loop(controller.signal).catch(error => this.log?.('ntfy 訂閱結束：', error.message));
  }
  stop() { this.controller?.abort(); this.controller = null; this.markReady(); this.onIdle?.(this); }
  async loop(signal) {
    let failures = 0, polls = 0;
    while (!signal.aborted && this.waiters.size) {
      const polling = this.mode === 'poll' || failures >= 2;
      try {
        if (polling) {
          await this.pollOnce(signal); this.markReady(); polls++;
          // poll 一陣子後再試一次串流（網路恢復後回到即時模式）
          if (this.mode !== 'poll' && polls >= 15) { failures = 0; polls = 0; } else await sleep(this.pollMs, signal);
        } else { await this.streamOnce(signal); failures = 0; await sleep(500, signal); }
      } catch (error) {
        if (signal.aborted) return;
        failures++;
        this.log?.('ntfy 連線失敗，稍後重試：', String(error.message || error).slice(0, 200));
        await sleep(Math.min(this.pollMs * Math.min(failures, 4), 15000), signal);
      }
    }
  }
  url(extra) { return `${this.server}/${encodeURIComponent(this.topic)}/json?${extra}since=${encodeURIComponent(this.sinceParam())}`; }
  async pollOnce(signal) {
    const linked = linkedSignal(signal, Math.min(this.idleMs, 30000));
    try {
      const res = await this.fetchImpl(this.url('poll=1&'), { signal: linked.signal, redirect: 'error', headers: { Accept: 'application/x-ndjson' } });
      if (!res.ok) { res.body?.cancel?.().catch(() => {}); throw new Error(`ntfy poll 失敗（HTTP ${res.status}）`); }
      const text = await readBounded(res, LINE_LIMIT, linked.signal);
      for (const line of text.split('\n')) if (line.trim()) await this.handleLine(line.trim(), linked.signal);
    } finally { linked.done(); }
  }
  async streamOnce(outer) {
    const local = new AbortController();
    const onAbort = () => local.abort();
    outer.addEventListener('abort', onAbort, { once: true });
    let idle = null, reader = null;
    const kick = () => { clearTimeout(idle); idle = setTimeout(() => local.abort(), this.idleMs); };
    try {
      kick();
      const res = await this.fetchImpl(this.url(''), { signal: local.signal, redirect: 'error', headers: { Accept: 'application/x-ndjson' } });
      if (!res.ok) throw new Error(`ntfy 串流連線失敗（HTTP ${res.status}）`);
      if (!res.body || typeof res.body.getReader !== 'function') throw new Error('ntfy 串流不支援');
      this.markReady();
      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        let chunk;
        try { chunk = await reader.read(); } catch (error) { if (outer.aborted) return; if (local.signal.aborted) throw new Error('ntfy 串流閒置過久，重新連線'); throw error; }
        if (chunk.done) break;
        kick();
        if (chunk.value.byteLength > LINE_LIMIT) throw new Error('ntfy 串流資料超過大小上限');
        buf += decoder.decode(chunk.value, { stream: true });
        if (Buffer.byteLength(buf) > LINE_LIMIT) throw new Error('ntfy 串流資料超過大小上限');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) await this.handleLine(line, outer); }
        ensureActive(outer);
      }
    } catch (error) {
      if (outer.aborted) return;
      if (local.signal.aborted && !(error instanceof TypeError)) throw new Error('ntfy 串流閒置過久，重新連線');
      throw error;
    } finally { reader?.cancel().catch(() => {}); clearTimeout(idle); outer.removeEventListener('abort', onAbort); }
  }
  async handleLine(line, signal) {
    if (signal.aborted || Buffer.byteLength(line) > LINE_LIMIT) return;
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (!ev || typeof ev !== 'object') return;
    if (ev.event === 'open' || ev.event === 'keepalive') { this.markReady(); return; }
    if (ev.event !== 'message') return;
    if (ev.id) {
      if (this.seen.has(ev.id)) return;
      this.seen.add(ev.id); this.lastId = String(ev.id);
      if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value);
    }
    if (!this.waiters.size) return;
    let payload = parseReplyPayload(ev.message);
    // 超過 4KB 的發佈內容 ntfy 會改成附件：只從同一台 ntfy 伺服器下載
    if (!payload && ev.attachment?.url) payload = await this.readAttachment(ev.attachment, signal).catch(error => { this.log?.('讀取 ntfy 附件失敗：', error.message); return null; });
    if (!payload || typeof payload.message_id !== 'string') return;
    const w = this.waiters.get(payload.message_id);
    if (!w) return;
    if (typeof payload.conversation_id !== 'string' || payload.conversation_id !== w.conversationId || typeof payload.ok !== 'boolean') return;
    if (typeof payload.reply !== 'string' || Buffer.byteLength(payload.reply) > REPLY_LIMIT) return;
    const reply = payload.reply;
    if (payload.ok === false) { w.reject(Object.assign(new Error(`Grok Bot 回報這次執行失敗：${clip(reply || '沒有提供原因', 2000)}`), { code: 'GROKBOT_FAILED' })); return; }
    if (!reply.trim()) { w.reject(Object.assign(new Error('Grok Bot 回傳了空白回覆'), { code: 'GROKBOT_EMPTY' })); return; }
    w.resolve({ reply, messageId: payload.message_id, conversationId: String(payload.conversation_id || ''), eventId: ev.id || '' });
  }
  async readAttachment(att, signal) {
    const u = new URL(String(att.url));
    checkUrl(u.href, 'ntfy 附件');
    if (u.origin !== new URL(this.server).origin) throw new Error('附件不在設定的 ntfy 伺服器上，已忽略');
    if (Number(att.size) > ATTACHMENT_LIMIT) throw new Error('附件太大，已忽略');
    const linked = linkedSignal(signal, 15000);
    try {
      const res = await this.fetchImpl(u.href, { signal: linked.signal, redirect: 'error' });
      if (!res.ok) { res.body?.cancel?.().catch(() => {}); throw new Error(`HTTP ${res.status}`); }
      return parseReplyPayload(await readBounded(res, ATTACHMENT_LIMIT, linked.signal));
    } finally { linked.done(); }
  }
}

function create({ fetch: fetchImpl = globalThis.fetch, pollMs = 4000, idleMs = 120000, mode = 'stream', log = null, postTimeoutMs = POST_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('這個版本的執行環境沒有 fetch，無法連線 Grok Bot');
  const subscribers = new Map();
  const subscriber = cfg => {
    const id = `${cfg.ntfyServer}|${cfg.ntfyTopic}`;
    if (!subscribers.has(id)) subscribers.set(id, new Subscriber({ server: cfg.ntfyServer, topic: cfg.ntfyTopic, fetchImpl, pollMs, idleMs, mode, log, onIdle: s => { if (subscribers.get(id) === s) subscribers.delete(id); } }));
    return subscribers.get(id);
  };
  async function postWebhook(cfg, body, signal) {
    const linked = linkedSignal(signal, postTimeoutMs);
    try {
      ensureActive(signal);
      const res = await fetchImpl(cfg.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...authHeaders(cfg.webhookKey, body) }, body, signal: linked.signal, redirect: 'error' });
      const detail = await readBounded(res, 64 * 1024, linked.signal);
      if (res.status < 200 || res.status >= 300) throw webhookError(res.status, redact(detail.replace(/\s+/g, ' ').trim().slice(0, 300), cfg.webhookKey));
      return res.status;
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (linked.signal.aborted) throw Object.assign(new Error('Grok Bot Webhook 連線逾時；遠端 routine 可能仍在執行，請先查看執行紀錄再決定是否重送。'), { code: 'GROKBOT_WEBHOOK' });
      if (error.code === 'GROKBOT_WEBHOOK') throw error;
      throw Object.assign(new Error(`Grok Bot Webhook 連線失敗：${redact(error.cause?.message || error.message, cfg.webhookKey)}`), { code: 'GROKBOT_WEBHOOK' });
    } finally { linked.done(); }
  }
  /**
   * 送出一則訊息並等待回覆。
   * @returns {Promise<{reply:string,messageId:string,conversationId:string,status:number}>}
   */
  async function send({ config, conversationId, message, history = [], workspace = '', signal, onStatus = () => {}, onRequest = async () => {}, timeoutMs = REPLY_TIMEOUT_MS }) {
    const cfg = validateConfig(config);
    ensureActive(signal);
    if (!String(conversationId || '') || String(conversationId).length > 512) throw Object.assign(new Error('Grok Bot 對話識別碼格式錯誤'), { code: 'GROKBOT_BAD_CONFIG' });
    const messageId = crypto.randomUUID();
    const deadline = linkedSignal(signal, timeoutMs);
    const activeSignal = deadline.signal;
    const body = buildBody({ conversationId, messageId, message, history: buildHistory(history), workspace });
    const sub = subscriber(cfg);
    const reply = sub.wait({ messageId, conversationId, signal: activeSignal, timeoutMs, since: Math.floor(Date.now() / 1000) - 15 });
    reply.catch(() => {});
    let ticker;
    try {
      await awaitActive(Promise.resolve().then(() => {
        ensureActive(activeSignal);
        return onRequest({ messageId, conversationId: String(conversationId) });
      }), activeSignal);
      ensureActive(activeSignal);
      await sub.whenReady(3000);
      ensureActive(activeSignal);
      onStatus('正在連線 Grok Bot…');
      const status = await postWebhook(cfg, body, activeSignal);
      ensureActive(activeSignal);
      const started = Date.now();
      onStatus(PENDING_STATUS);
      ticker = setInterval(() => {
        if (!activeSignal.aborted) onStatus(`Grok Bot 處理中…（已等待 ${Math.round((Date.now() - started) / 1000)} 秒）`);
      }, 15000);
      const result = await reply;
      ensureActive(activeSignal);
      return { ...result, status };
    } catch (error) {
      sub.cancel(messageId, error);
      if (signal?.aborted) throw abortError();
      if (activeSignal.aborted || error.code === 'GROKBOT_TIMEOUT') throw Object.assign(new Error('Grok Bot 回覆逾時；遠端 routine 可能仍在執行，請先查看執行紀錄再決定是否重送。'), { code: 'GROKBOT_TIMEOUT' });
      throw error;
    } finally { clearInterval(ticker); deadline.done(); }
  }
  /** 只讀測試 ntfy 主題能否連線（不會呼叫 webhook、不花用量）。 */
  async function checkNtfy(config, { signal } = {}) {
    const cfg = validateConfig(config, { requireWebhook: false });
    const linked = linkedSignal(signal, 15000);
    try {
      const res = await fetchImpl(`${cfg.ntfyServer}/${encodeURIComponent(cfg.ntfyTopic)}/json?poll=1&since=1m`, { signal: linked.signal, redirect: 'error' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await readBounded(res, LINE_LIMIT, linked.signal);
      return { ok: true, message: `ntfy 連線正常：${cfg.ntfyServer}/${cfg.ntfyTopic}` };
    } catch (error) {
      return { ok: false, message: `ntfy 連線失敗：${linked.signal.aborted && !signal?.aborted ? '逾時' : error.message}` };
    } finally { linked.done(); }
  }
  function close() { for (const s of subscribers.values()) { for (const id of [...s.waiters.keys()]) s.cancel(id); s.stop(); } subscribers.clear(); }
  return { send, checkNtfy, close, pending: () => [...subscribers.values()].reduce((n, s) => n + s.waiters.size, 0), subscriberCount: () => subscribers.size };
}

module.exports = { create, normalizeConfig, validateConfig, cleanKey, buildHistory, buildBody, authHeaders, parseReplyPayload, DEFAULT_TOPIC, DEFAULT_SERVER, REPLY_TIMEOUT_MS, PENDING_STATUS, HISTORY_LIMIT };
