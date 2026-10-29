'use strict';
// SearXNG 元搜尋引擎擴充。
//
// SearXNG 本身不爬網頁，它是把同一個查詢同時丟給 Google、Bing、Yahoo、Yandex、DuckDuckGo……
// 再把結果合併、去重、標出每一筆是哪幾個引擎找到的。Scrapling 則是「給網址、抓內容」，
// 兩者剛好互補：先用 SearXNG 找出候選網址，再用 Scrapling 讀全文。
//
// 這台電腦沒有 Docker，所以在 Windows 原生執行：
//   ・原始碼 git clone 到 %USERPROFILE%\.searxng\src（跳過 utils/templates：那裡有檔名含「:」的伺服器範本，Windows 放不下）
//   ・Python 環境在 %USERPROFILE%\.searxng\venv（uv 建立；另外補 tzdata，Windows 沒有時區資料）
//   ・用 searxng_launcher.py 啟動（補上 Linux 專用的 pwd 模組），只聽 127.0.0.1，第一次搜尋時才啟動，App 結束時一起關掉
// 也可以改填一個現成的 SearXNG 網址（需要開啟 JSON 輸出）。
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const WIN = process.platform === 'win32';
const REPO = 'https://github.com/searxng/searxng.git';
const DEFAULT_PORT = 8898;
// 窮搜預設引擎：都是「一般網頁」類、在這台電腦實測過會回結果或偶爾被限流的；
// 被對方擋（驗證碼、限流）時 SearXNG 會自己暫停那個引擎，結果照樣從其他引擎來。
const DEEP_ENGINES = ['google', 'bing', 'yahoo', 'yandex', 'duckduckgo web', 'brave', 'qwant', 'mwmbl', 'yep', 'naver', 'wikipedia', 'google cse'];
const CATEGORY_ENGINES = {
  news: ['google news', 'bing news', 'duckduckgo news', 'yahoo news'],
  science: ['google scholar', 'arxiv', 'semantic scholar', 'pubmed', 'crossref', 'openalex'],
  it: ['github', 'stackoverflow', 'npm', 'pypi', 'huggingface', 'docker hub'],
};

const exists = (p) => { try { return !!p && fs.statSync(p).isFile(); } catch { return false; } };

function paths(cfg = {}) {
  const root = String(cfg.root || '').trim() || path.join(os.homedir(), '.searxng');
  return {
    root,
    src: path.join(root, 'src'),
    venv: path.join(root, 'venv'),
    python: path.join(root, 'venv', WIN ? 'Scripts' : 'bin', WIN ? 'python.exe' : 'python'),
    settings: path.join(root, 'codex-multi-settings.yml'),
    log: path.join(root, 'codex-multi-searxng.log'),
    launcher: path.join(__dirname, 'searxng_launcher.py'),
  };
}

const externalUrl = (cfg = {}) => String(cfg.url || '').trim().replace(/\/+$/, '');
const installed = (cfg = {}) => { const p = paths(cfg); return exists(path.join(p.src, 'searx', 'webapp.py')) && exists(p.python); };
const portOf = (cfg = {}) => { const n = Math.floor(Number(cfg.port)); return n >= 1024 && n <= 65535 ? n : DEFAULT_PORT; };

function engineList(text, fallback) {
  const list = (Array.isArray(text) ? text : String(text || '').split(/[,，、\n]/)).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  return list.length ? [...new Set(list)] : fallback;
}

function status(cfg = {}) {
  const url = externalUrl(cfg);
  if (url) return { available: true, path: url, note: `使用現成的 SearXNG：${url}（需要開啟 JSON 輸出）` };
  const p = paths(cfg);
  if (installed(cfg)) {
    const running = service && !service.exited ? `，目前在 ${service.url} 執行中` : '，第一次搜尋時會在背景啟動（只聽本機 127.0.0.1）';
    return { available: true, path: p.root, note: `已安裝在 ${p.root}${running}` };
  }
  return { available: false, path: '', note: `還沒安裝 SearXNG。按下面的「安裝 SearXNG」，會下載到 ${p.root}（約 150 MB，需要 git 與 uv 或 Python 3.10 以上）；或填一個現成的 SearXNG 網址。` };
}

// ---- 設定檔 ----
function writeSettings(cfg = {}) {
  const p = paths(cfg);
  const port = portOf(cfg);
  let secret = '';
  try { secret = (/secret_key:\s*"([0-9a-f]{32,})"/.exec(fs.readFileSync(p.settings, 'utf8')) || [])[1] || ''; } catch { /* 第一次 */ }
  if (!secret) secret = crypto.randomBytes(24).toString('hex');
  const yml = [
    '# 由 Codex Multi 產生；每次啟動會重寫，要改請到「API 設定 → 能力擴充 → SearXNG」。',
    'use_default_settings: true',
    'general:',
    '  instance_name: "Codex Multi SearXNG"',
    '  enable_metrics: false',
    'server:',
    `  secret_key: "${secret}"`,
    '  bind_address: "127.0.0.1"',
    `  port: ${port}`,
    '  limiter: false',
    '  public_instance: false',
    '  image_proxy: false',
    'search:',
    '  safe_search: 0',
    '  autocomplete: ""',
    '  formats: [html, json]',
    'outgoing:',
    '  request_timeout: 6.0',
    '  max_request_timeout: 15.0',
    'valkey:',
    '  url: false',
    '',
  ].join('\n');
  fs.mkdirSync(p.root, { recursive: true });
  fs.writeFileSync(p.settings, yml, 'utf8');
  return p.settings;
}

// ---- 本機服務 ----
let service = null; // { proc, url, port, exited, ready, log[] }

async function ping(base, ms = 3000) {
  try {
    const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(ms) });
    return r.ok;
  } catch { return false; }
}

/** 某個埠上是不是我們（或使用者自己）開的 SearXNG：/config 會回 JSON 且有 engines。 */
async function isSearxng(base) {
  try {
    const r = await fetch(`${base}/config`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return false;
    const j = await r.json();
    return Array.isArray(j.engines);
  } catch { return false; }
}

function tail(lines, n = 12) { return lines.slice(-n).join('\n'); }

/** 回傳可用的 SearXNG 網址；本機版沒在跑就在背景啟動（不開任何視窗）。 */
async function ensure(cfg = {}, { signal, onProgress } = {}) {
  const url = externalUrl(cfg);
  if (url) {
    if (!(await ping(url, 8000)) && !(await isSearxng(url))) throw new Error(`連不到 SearXNG：${url}`);
    return url;
  }
  if (service && !service.exited) { await service.ready; touchService(); return service.url; }
  if (!installed(cfg)) throw new Error(status(cfg).note);
  const p = paths(cfg);
  const port = portOf(cfg);
  const base = `http://127.0.0.1:${port}`;
  // App 上次當掉留下的那份還在跑：直接沿用，不要再開一份搶同一個埠
  if (await ping(base, 1500)) {
    if (await isSearxng(base)) return base;
    throw new Error(`埠 ${port} 已經被別的程式佔用，請到「API 設定 → 能力擴充 → SearXNG」改一個埠。`);
  }
  writeSettings(cfg);
  onProgress?.('正在背景啟動 SearXNG…');
  const log = [];
  const proc = spawn(p.python, [p.launcher, p.src, '127.0.0.1', String(port)], {
    cwd: p.src,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SEARXNG_SETTINGS_PATH: p.settings, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ELECTRON_RUN_AS_NODE: undefined },
  });
  const me = { proc, url: base, port, exited: false, log, ready: null };
  service = me;
  let logFile = null;
  try { logFile = fs.createWriteStream(p.log, { flags: 'w' }); } catch { /* 寫不了紀錄不影響搜尋 */ }
  const onData = (d) => {
    const text = d.toString('utf8');
    logFile?.write(text);
    for (const line of text.split(/\r?\n/)) if (line.trim()) { log.push(line); if (log.length > 200) log.shift(); }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('exit', () => { me.exited = true; try { logFile?.end(); } catch { /* */ } if (service === me) service = null; });
  me.ready = (async () => {
    const started = Date.now();
    while (Date.now() - started < 120000) {
      if (signal?.aborted) break;
      if (me.exited) throw new Error(`SearXNG 啟動失敗：\n${tail(log)}`);
      if (await ping(base, 1500)) return base;
      await new Promise((r) => setTimeout(r, 700));
    }
    stop();
    throw new Error(signal?.aborted ? '已取消' : `SearXNG 兩分鐘內沒有啟動完成：\n${tail(log)}`);
  })();
  me.ready.catch(() => {});
  me.ready.then(() => touchService(), () => {});
  return me.ready;
}

function stop() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const s = service;
  service = null;
  if (!s || s.exited) return;
  try {
    if (WIN) spawn('taskkill', ['/pid', String(s.proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else s.proc.kill();
  } catch { /* 已結束 */ }
}

// ---- 查詢 ----
const ERR_ZH = [
  [/captcha/i, '被要求驗證碼'],
  [/too many requests|suspended/i, '被限流，暫停中'],
  [/timeout/i, '逾時'],
  [/access denied|forbidden|403/i, '被拒絕存取'],
  [/crash/i, '解析失敗'],
];
const zhReason = (s) => { for (const [re, t] of ERR_ZH) if (re.test(String(s))) return t; return String(s || '失敗'); };

// 同一個查詢短時間內重複問（窮搜的多種寫法常重疊、模型也常重複查）直接用快取，不再打一輪引擎
const CACHE_TTL_MS = Number(process.env.CODEX_MULTI_SEARXNG_CACHE_MS) || 10 * 60000;
const CACHE_MAX = 100;
const queryCache = new Map(); // key -> { at, value }
const inflight = new Map(); // key -> Promise

// 本機服務閒置一段時間就關掉，下次搜尋再背景啟動
const SERVICE_IDLE_MS = Number(process.env.CODEX_MULTI_SEARXNG_IDLE_MS) || 15 * 60000;
let idleTimer = null;
function touchService() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (!service) return;
  idleTimer = setTimeout(() => { idleTimer = null; if (!inflight.size) stop(); else touchService(); }, SERVICE_IDLE_MS);
  idleTimer.unref?.();
}

function query(base, params, opts = {}) {
  const sig = JSON.stringify([base, Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').sort(([a], [b]) => a.localeCompare(b))]);
  const hit = queryCache.get(sig);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) { queryCache.delete(sig); queryCache.set(sig, hit); return Promise.resolve(hit.value); }
  if (base === service?.url) touchService();
  // 完全相同的查詢正在跑：共用同一次請求，不重複打
  if (inflight.has(sig) && !opts.signal) return inflight.get(sig);
  const p = queryUncached(base, params, opts).then((value) => {
    queryCache.set(sig, { at: Date.now(), value });
    while (queryCache.size > CACHE_MAX) queryCache.delete(queryCache.keys().next().value);
    return value;
  }).finally(() => { inflight.delete(sig); });
  if (!opts.signal) inflight.set(sig, p);
  return p;
}

async function queryUncached(base, params, { signal } = {}) {
  const u = new URL(`${base}/search`);
  u.searchParams.set('format', 'json');
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  const r = await fetch(u, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000), headers: { Accept: 'application/json' } });
  if (r.status === 403) throw new Error('這個 SearXNG 沒有開啟 JSON 輸出（settings.yml 的 search.formats 要包含 json）。');
  if (r.status === 429) throw new Error('SearXNG 回報太多請求（限流器開著）。自架的請把 server.limiter 關掉。');
  if (!r.ok) throw new Error(`SearXNG 回應 HTTP ${r.status}`);
  const j = await r.json();
  return {
    results: Array.isArray(j.results) ? j.results : [],
    answers: Array.isArray(j.answers) ? j.answers : [],
    suggestions: Array.isArray(j.suggestions) ? j.suggestions : [],
    infoboxes: Array.isArray(j.infoboxes) ? j.infoboxes : [],
    unresponsive: Array.isArray(j.unresponsive_engines) ? j.unresponsive_engines : [],
  };
}

/** 同一篇文章常以 http/https、有無 www、帶追蹤參數等不同網址出現；比對時要當成同一筆。 */
function normUrl(raw) {
  try {
    const u = new URL(String(raw));
    const drop = /^(utm_|fbclid$|gclid$|ref$|ref_src$|spm$|from$)/i;
    const keep = [...u.searchParams.entries()].filter(([k]) => !drop.test(k)).sort(([a], [b]) => a.localeCompare(b));
    const q = keep.length ? `?${new URLSearchParams(keep).toString()}` : '';
    return `${u.hostname.replace(/^www\./i, '').toLowerCase()}${u.pathname.replace(/\/+$/, '') || '/'}${q}`;
  } catch { return String(raw || '').trim().toLowerCase(); }
}

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const clampInt = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const TIME_RANGES = new Set(['day', 'week', 'month', 'year']);

function baseParams(args = {}) {
  return {
    language: String(args.language || '').trim() || 'auto',
    time_range: TIME_RANGES.has(args.time_range) ? args.time_range : '',
    safesearch: [0, 1, 2].includes(Number(args.safesearch)) ? Number(args.safesearch) : 0,
  };
}

function formatResults(list, max) {
  return list.slice(0, max).map((r, i) => {
    const eng = r.engines && r.engines.length ? `［${r.engines.join('、')}］` : '';
    const date = r.publishedDate ? `（${String(r.publishedDate).slice(0, 10)}）` : '';
    return `${i + 1}. ${clip(r.title, 160) || '(無標題)'}${date}\n   ${r.url}\n   ${eng}${r.content ? ` ${clip(r.content, 300)}` : ''}`;
  }).join('\n');
}

function failureLines(unresponsive, hits) {
  const m = new Map();
  for (const [name, why] of unresponsive) if (!m.has(name)) m.set(name, zhReason(why));
  return [...m].map(([n, w]) => `${n}（${hits && hits.has(n) ? `部分查詢${w}，其餘有結果` : w}）`);
}

/** 一般搜尋：一次查詢、一頁。 */
async function search(base, args = {}, { signal } = {}, cfg = {}) {
  const q = String(args.query || '').trim();
  if (!q) throw new Error('query 不能是空的');
  const max = clampInt(args.max_results, 1, 50, 15);
  const params = { q, ...baseParams(args), pageno: clampInt(args.page, 1, 10, 1) };
  // SearXNG 預設只開少數幾個一般引擎，而且常被限流；一般搜尋也直接指定那組多引擎，
  // 其他分類（news、science、it）有對應的引擎組就用它，沒有才交給 SearXNG 的分類預設
  const cat = String(args.categories || 'general').trim() || 'general';
  const engines = engineList(args.engines, null) || (cat === 'general' ? engineList(cfg.deepEngines, DEEP_ENGINES) : CATEGORY_ENGINES[cat] || null);
  if (engines) params.engines = engines.join(',');
  else params.categories = cat;
  const r = await query(base, params, { signal });
  const lines = [`SearXNG 搜尋「${q}」：${r.results.length} 筆結果${engines ? `（引擎：${engines.join("、")}）` : `（分類：${params.categories}）`}`];
  const fails = failureLines(r.unresponsive);
  if (fails.length) lines.push(`沒有回應的引擎：${fails.join('、')}`);
  if (r.answers.length) lines.push(`直接答案：${r.answers.map((a) => clip(a.answer || a, 300)).join('；')}`);
  for (const box of r.infoboxes.slice(0, 2)) lines.push(`資訊框：${clip(box.infobox, 80)}：${clip(box.content, 400)}`);
  lines.push('', formatResults(r.results, max) || '（沒有結果）');
  if (r.suggestions.length) lines.push('', `相關搜尋建議：${r.suggestions.slice(0, 8).join('、')}`);
  return lines.join('\n');
}

/** 並行度受限地跑一串非同步工作。 */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 窮搜：多個查詢寫法 × 多頁 × 一大組引擎，合併去重後依「被幾個引擎、幾種寫法找到」排序。
 * 被越多獨立引擎找到的網址通常越相關；只有單一引擎找到的也保留，排在後面。
 */
async function deepSearch(base, args = {}, cfg = {}, { signal, onProgress } = {}) {
  const main = String(args.query || '').trim();
  if (!main) throw new Error('query 不能是空的');
  const variants = (Array.isArray(args.variants) ? args.variants : String(args.variants || '').split('\n'))
    .map((s) => String(s).trim()).filter(Boolean);
  const queries = [...new Set([main, ...variants])].slice(0, 8);
  const pages = clampInt(args.pages, 1, 5, 2);
  const max = clampInt(args.max_results, 5, 150, 40);
  const cat = String(args.categories || 'general').trim() || 'general';
  const engines = engineList(args.engines, CATEGORY_ENGINES[cat] || engineList(cfg.deepEngines, DEEP_ENGINES));
  const jobs = [];
  for (const q of queries) for (let p = 1; p <= pages; p++) jobs.push({ q, p });

  const merged = new Map();
  const perEngine = new Map();
  const failed = [];
  let done = 0;
  let requestErrors = 0;
  await pool(jobs, 3, async (job) => {
    if (signal?.aborted) return;
    try {
      const r = await query(base, { q: job.q, ...baseParams(args), pageno: job.p, engines: engines.join(',') }, { signal });
      failed.push(...r.unresponsive);
      r.results.forEach((x, idx) => {
        if (!x || !x.url) return;
        const key = normUrl(x.url);
        let it = merged.get(key);
        if (!it) { it = { title: x.title, url: x.url, content: '', engines: new Set(), queries: new Set(), best: Infinity, publishedDate: x.publishedDate || '' }; merged.set(key, it); }
        if (String(x.content || '').length > it.content.length) it.content = String(x.content || '');
        if (!it.title && x.title) it.title = x.title;
        for (const e of x.engines || []) { it.engines.add(e); perEngine.set(e, (perEngine.get(e) || 0) + 1); }
        it.queries.add(job.q);
        it.best = Math.min(it.best, (job.p - 1) * 10 + idx + 1);
      });
    } catch (e) {
      if (signal?.aborted) return;
      requestErrors++;
      failed.push(['(請求)', e.message]);
    } finally {
      done++;
      onProgress?.(`SearXNG 窮搜 ${done}/${jobs.length}：已找到 ${merged.size} 個不重複網址`);
    }
  });
  if (signal?.aborted) throw new Error('已取消');
  if (requestErrors === jobs.length) throw new Error(`SearXNG 每一次查詢都失敗：${clip(failed.map((f) => f[1]).join('；'), 400)}`);

  const ranked = [...merged.values()].map((it) => ({
    ...it, engines: [...it.engines], queries: [...it.queries],
    score: it.engines.size * 3 + it.queries.size * 2 + 5 / it.best,
  })).sort((a, b) => b.score - a.score);
  const multi = ranked.filter((r) => r.engines.length >= 2).length;
  const hitLine = [...perEngine].sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e} ${n}`).join('、') || '（沒有任何引擎回傳結果）';
  const silent = engines.filter((e) => !perEngine.has(e) && !failed.some((f) => f[0] === e));
  const lines = [
    `SearXNG 窮搜「${main}」：${queries.length} 種寫法 × ${pages} 頁 × ${engines.length} 個引擎，共 ${jobs.length} 次查詢`,
    `找到 ${merged.size} 個不重複網址，其中 ${multi} 個被 2 個以上引擎同時找到（排在前面）。`,
    `各引擎貢獻：${hitLine}`,
  ];
  const fails = failureLines(failed.filter((f) => f[0] !== '(請求)'), perEngine);
  if (fails.length) lines.push(`被擋或沒回應：${fails.join('、')}`);
  if (silent.length) lines.push(`有回應但這次沒結果：${silent.join('、')}`);
  if (requestErrors) lines.push(`有 ${requestErrors} 次查詢整個失敗。`);
  lines.push(`查詢寫法：${queries.map((q) => `「${q}」`).join('、')}`);
  lines.push('', formatResults(ranked, max) || '（沒有結果）');
  if (ranked.length > max) lines.push('', `另有 ${ranked.length - max} 筆排序較後的結果沒有列出；需要的話把 max_results 調高。`);
  return lines.join('\n');
}

async function engines(base, args = {}) {
  const r = await fetch(`${base}/config`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`SearXNG /config 回應 HTTP ${r.status}`);
  const j = await r.json();
  const cat = String(args.category || '').trim();
  const list = (j.engines || []).filter((e) => !cat || (e.categories || []).includes(cat));
  const cats = [...new Set((j.engines || []).flatMap((e) => e.categories || []))].sort();
  const row = (e) => `${e.name}${e.shortcut ? `（!${e.shortcut}）` : ''}${e.enabled ? '' : ' [預設關閉，可在 engines 參數指定]'}`;
  return [`SearXNG 共 ${(j.engines || []).length} 個引擎${cat ? `，分類「${cat}」有 ${list.length} 個` : ''}。`,
    `分類：${cats.join('、')}`, '', list.map(row).join('\n')].join('\n');
}

// ---- 安裝 ----
function run(cmd, args, { cwd, onLog, signal, env } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, windowsHide: true, env: { ...process.env, ...(env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    // 輸出是一塊一塊來的，一行可能被切成好幾塊；留著不完整的尾巴，等下一塊接上再送出
    const lineReader = () => {
      let carry = '';
      const emit = (line) => { if (line.trim()) { out.push(line); onLog?.(line); } };
      return { data: (d) => { const parts = (carry + d.toString('utf8')).split(/\r?\n|\r/); carry = parts.pop(); parts.forEach(emit); }, end: () => { emit(carry); carry = ''; } };
    };
    const so = lineReader();
    const se = lineReader();
    p.stdout.on('data', so.data);
    p.stderr.on('data', se.data);
    const abort = () => { try { p.kill(); } catch { /* */ } };
    signal?.addEventListener('abort', abort, { once: true });
    p.on('error', (e) => reject(new Error(`無法執行 ${cmd}：${e.message}`)));
    p.on('close', (code) => {
      so.end(); se.end();
      signal?.removeEventListener('abort', abort);
      if (code === 0) resolve(out.join('\n'));
      else reject(new Error(`${path.basename(cmd)} ${args.slice(0, 3).join(' ')} 失敗（代碼 ${code}）：\n${out.slice(-8).join('\n')}`));
    });
  });
}

function findOnPath(names) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    for (const n of names) { const p = path.join(dir.trim(), n); if (exists(p)) return p; }
  }
  return null;
}

/**
 * 下載並安裝（已經裝過就更新）。步驟：
 *   1. git clone（跳過 utils/templates）或 git pull
 *   2. 建 Python 環境（有 uv 用 uv，否則用系統 Python 3.10+ 的 venv）
 *   3. 安裝 requirements.txt ＋ tzdata
 *   4. 啟動一次、查一次，確認真的能用
 */
async function install(cfg = {}, { onLog, signal, uv: uvPath, git: gitPath } = {}) {
  const p = paths(cfg);
  const log = (s) => onLog?.(s);
  const git = gitPath || findOnPath(WIN ? ['git.exe', 'git.cmd'] : ['git']);
  if (!git) throw new Error('找不到 git。請先安裝 Git for Windows（https://git-scm.com），再按一次安裝。');
  const uv = uvPath || require('./extensions').findUv('');
  fs.mkdirSync(p.root, { recursive: true });
  stop();

  if (exists(path.join(p.src, 'searx', 'webapp.py')) && fs.existsSync(path.join(p.src, '.git'))) {
    log('[1/4] 已有 SearXNG 原始碼，更新到最新版…');
    try {
      // 舊的或手動 clone 的倉庫可能沒排除 utils/templates，更新前補上同樣的設定
      await run(git, ['-C', p.src, 'config', 'core.protectNTFS', 'false'], { onLog: log, signal });
      await run(git, ['-C', p.src, 'sparse-checkout', 'set', '--no-cone', '/*', '!/utils/templates/'], { onLog: log, signal }); await run(git, ['-c', 'core.protectNTFS=false', '-C', p.src, 'pull', '--ff-only'], { onLog: log, signal }); }
    catch (e) { log(`更新失敗，沿用現有版本：${e.message.split('\n')[0]}`); }
  } else {
    if (fs.existsSync(p.src) && fs.readdirSync(p.src).length) throw new Error(`${p.src} 已經有別的東西，請先把它移走或改名，再按一次安裝。`);
    log('[1/4] 下載 SearXNG 原始碼（git clone）…');
    await run(git, ['clone', '--depth', '1', '--no-checkout', REPO, p.src], { onLog: log, signal });
    // Windows 不允許檔名有「:」，utils/templates 裡有幾個伺服器範本就是這種檔名；本機執行用不到它們。
    // sparse-checkout 讓它們不會寫到磁碟；但 git 讀索引時仍會檢查路徑，所以這個倉庫要關掉 NTFS 路徑檢查
    // （被排除的檔案從不落地，關掉也不會產生奇怪的檔案）。
    await run(git, ['-C', p.src, 'config', 'core.protectNTFS', 'false'], { onLog: log, signal });
    await run(git, ['-C', p.src, 'sparse-checkout', 'set', '--no-cone', '/*', '!/utils/templates/'], { onLog: log, signal });
    await run(git, ['-C', p.src, 'checkout'], { onLog: log, signal });
  }
  if (!exists(path.join(p.src, 'searx', 'webapp.py'))) throw new Error('下載完成但找不到 searx/webapp.py，原始碼不完整。');

  const req = path.join(p.src, 'requirements.txt');
  if (uv) {
    if (!exists(p.python)) {
      log('[2/4] 用 uv 建立 Python 3.11 環境…');
      await run(uv, ['venv', '--python', '3.11', p.venv], { onLog: log, signal });
    } else log('[2/4] Python 環境已存在。');
    log('[3/4] 安裝相依套件（第一次約 1～3 分鐘）…');
    await run(uv, ['pip', 'install', '--python', p.python, '-r', req, 'tzdata'], { onLog: log, signal });
  } else {
    const py = findOnPath(WIN ? ['python.exe'] : ['python3', 'python']);
    if (!py) throw new Error('找不到 uv 也找不到 Python。請安裝 uv（https://docs.astral.sh/uv/）或 Python 3.10 以上。');
    if (!exists(p.python)) {
      log('[2/4] 建立 Python 環境（python -m venv）…');
      await run(py, ['-m', 'venv', p.venv], { onLog: log, signal });
    } else log('[2/4] Python 環境已存在。');
    log('[3/4] 安裝相依套件（第一次約 1～3 分鐘）…');
    await run(p.python, ['-m', 'pip', 'install', '-r', req, 'tzdata'], { onLog: log, signal });
  }

  log('[4/4] 試跑一次…');
  const base = await ensure(cfg, { signal, onProgress: log });
  const c = await fetch(`${base}/config`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json());
  const version = c.version || '';
  log(`完成：SearXNG ${version} 在 ${base} 執行中，共 ${(c.engines || []).length} 個引擎。`);
  return { ok: true, root: p.root, url: base, version, engines: (c.engines || []).length };
}

/** 「測試連線」：啟動（或連上）後實際查一次，回報哪些引擎有回應。 */
async function test(cfg = {}, { signal } = {}) {
  const base = await ensure(cfg, { signal });
  const engs = engineList(cfg.deepEngines, DEEP_ENGINES);
  const r = await query(base, { q: 'open source metasearch engine', engines: engs.join(','), language: 'auto' }, { signal });
  const ok = [...new Set(r.results.flatMap((x) => x.engines || []))];
  const fails = failureLines(r.unresponsive);
  return {
    ok: r.results.length > 0,
    message: `SearXNG 在 ${base}：試查一次得到 ${r.results.length} 筆結果。\n有結果的引擎（${ok.length}）：${ok.join('、') || '無'}${fails.length ? `\n被擋或沒回應：${fails.join('、')}` : ''}`,
  };
}

function toolDefs(prefix) {
  const common = {
    language: { type: 'string', description: '可選：語言代碼，例如 zh-TW、en、ja；預設 auto' },
    time_range: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: '可選：只要這段時間內的結果' },
    categories: { type: 'string', description: '可選：分類，預設 general；也可用 news、science、it、images、videos 等（用 engines 工具看完整清單）' },
    engines: { type: 'string', description: '可選：指定引擎，逗號分隔（例如 google,bing,yandex）。預設關閉的引擎也能在這裡指定。' },
    max_results: { type: 'number', description: '可選：最多列出幾筆' },
  };
  return [
    { type: 'function', function: { name: `${prefix}_search`, description: 'SearXNG 元搜尋：同一個查詢同時問多個搜尋引擎，合併去重後回傳標題、網址、摘要，以及每筆是哪些引擎找到的。一般查資料用它；要讀網頁全文再用抓網頁工具。', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜尋字詞' }, page: { type: 'number', description: '可選：第幾頁，預設 1' }, ...common }, required: ['query'], additionalProperties: false } } },
    { type: 'function', function: { name: `${prefix}_deep_search`, description: 'SearXNG 窮搜：把多種查詢寫法 × 多頁 × 一大組引擎（預設 Google、Bing、Yahoo、Yandex、DuckDuckGo、Brave、Qwant、Mwmbl、Yep、Naver、Wikipedia 等）全部查過，合併去重，依「被幾個引擎、幾種寫法找到」排序，並回報每個引擎的貢獻與被擋的引擎。要找齊資料、查證、做文獻或市場調查時用它。請自己在 variants 補上同義詞、英文、不同說法。', parameters: { type: 'object', properties: { query: { type: 'string', description: '主要查詢' }, variants: { type: 'array', items: { type: 'string' }, description: '其他查詢寫法（同義詞、其他語言、加上引號的精確片語、site: 限定等），最多 7 個' }, pages: { type: 'number', description: '每種寫法查幾頁（1–5，預設 2）' }, ...common }, required: ['query'], additionalProperties: false } } },
    { type: 'function', function: { name: `${prefix}_engines`, description: '列出這個 SearXNG 有哪些引擎與分類（含預設關閉、但可以在 engines 參數指定的引擎）。', parameters: { type: 'object', properties: { category: { type: 'string', description: '可選：只列這個分類' } }, additionalProperties: false } } },
  ];
}

module.exports = {
  DEFAULT_PORT, DEEP_ENGINES, CATEGORY_ENGINES, paths, installed, status, writeSettings, ensure, stop, install, test,
  search, deepSearch, engines, toolDefs, normUrl, engineList,
  get running() { return !!(service && !service.exited); },
};
