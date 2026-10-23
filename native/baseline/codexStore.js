// 讀取 Codex 本機資料（唯讀，不會寫入或修改 Codex 的任何檔案）
// 來源：%USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-*.jsonl(.zst)
//       %USERPROFILE%\.codex\session_index.jsonl（執行緒名稱）
//       %USERPROFILE%\.codex\state_5.sqlite（側欄用的 threads / projects 表）
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const readline = require('readline');
const fzstd = require('fzstd');

const CTX_OPEN = '<<APP_CONTEXT>>';
const CTX_CLOSE = '<</APP_CONTEXT>>';
const ROLLOUT_RE = /rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([0-9a-fA-F-]{36})(?:_[0-9a-fA-F-]+)?\.jsonl(\.zst)?$/;

let SQL = null; // sql.js 實例（延遲載入）
const metaCache = new Map(); // filePath -> { mtimeMs, meta }

function codexHome(override) {
  if (override && override.trim()) return override.trim();
  if (process.env.CODEX_HOME) return process.env.CODEX_HOME;
  return path.join(os.homedir(), '.codex');
}

function normPath(p) {
  if (!p) return '';
  return String(p).replace(/^\\\\\?\\/, '').replace(/^\/\/\?\//, '');
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

// ---------- 逐行讀取（支援 .jsonl 與 .jsonl.zst） ----------
async function* readLines(filePath) {
  if (!filePath.endsWith('.zst')) {
    const rl = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) yield line;
    return;
  }
  const decoder = new TextDecoder('utf-8');
  let pending = '';
  const queue = [];
  const dec = new fzstd.Decompress((chunk) => { queue.push(chunk); });
  const stream = fs.createReadStream(filePath, { highWaterMark: 1 << 20 });
  for await (const buf of stream) {
    dec.push(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    while (queue.length) {
      pending += decoder.decode(queue.shift(), { stream: true });
      let idx;
      while ((idx = pending.indexOf('\n')) >= 0) {
        yield pending.slice(0, idx);
        pending = pending.slice(idx + 1);
      }
    }
  }
  try { dec.push(new Uint8Array(0), true); } catch { /* 已結束 */ }
  while (queue.length) pending += decoder.decode(queue.shift(), { stream: true });
  pending += decoder.decode();
  for (const line of pending.split('\n')) if (line) yield line;
}

// ---------- 掃描 sessions 目錄 ----------
async function walkRollouts(dir, out) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkRollouts(full, out);
    else if (ROLLOUT_RE.test(e.name)) out.push(full);
  }
}

async function readSessionMeta(filePath) {
  let st;
  try { st = await fsp.stat(filePath); } catch { return null; }
  const cached = metaCache.get(filePath);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.meta;

  const meta = { cwd: '', parentThreadId: null, originator: '', isSubagent: false, firstUser: '', mtimeMs: st.mtimeMs, hasUser: false };
  let n = 0;
  try {
    for await (const line of readLines(filePath)) {
      n++;
      if (!line) continue;
      if (n === 1 || line.includes('"session_meta"')) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'session_meta' && obj.payload) {
            const p = obj.payload;
            meta.cwd = normPath(p.cwd || '');
            meta.parentThreadId = p.parent_thread_id || null;
            meta.originator = String(p.originator || '');
            const src = p.source;
            // Zenith 的 worker 目前不寫 parent_thread_id，source 也只是 vscode；只看舊欄位會把內部工作對話漏到一般側欄。
            meta.isSubagent = !!p.parent_thread_id
              || (src && typeof src === 'object' && ('subagent' in src || 'sub_agent' in src))
              || /^(?:zenith|prime[-_ ]?agent)$/i.test(meta.originator);
            meta.createdAt = p.timestamp;
          }
        } catch { /* 忽略壞行 */ }
      }
      if (!meta.hasUser && /"role":\s*"user"/.test(line) && line.includes('"response_item"')) {
        try {
          const obj = JSON.parse(line);
          const p = obj.payload || {};
          if (obj.type === 'response_item' && p.type === 'message' && p.role === 'user') {
            const t = (p.content || []).filter((c) => typeof c.text === 'string' && !isSystemBlock(c.text)).map((c) => c.text).join('\n').trim();
            if (t) { meta.firstUser = stripAppContext(t).slice(0, 200); meta.hasUser = true; break; }
          }
        } catch { /* 忽略 */ }
      }
      if (line.includes('"user_message"')) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'event_msg' && obj.payload && obj.payload.type === 'user_message') {
            meta.firstUser = stripAppContext(obj.payload.message || '').slice(0, 200);
            meta.hasUser = true;
            break;
          }
        } catch { /* 忽略 */ }
      }
      if (n > 400) break; // 標題只需要前段內容
    }
  } catch { /* 檔案可能正在寫入或壓縮中 */ }
  metaCache.set(filePath, { mtimeMs: st.mtimeMs, meta });
  return meta;
}

async function readSessionIndex(home) {
  const names = new Map();
  const file = path.join(home, 'session_index.jsonl');
  if (!(await exists(file))) return names;
  try {
    const text = await fsp.readFile(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.id && typeof e.thread_name === 'string') names.set(e.id, e.thread_name); // 後寫入者為準
      } catch { /* 忽略 */ }
    }
  } catch { /* 忽略 */ }
  return names;
}

// ---------- 讀 state_5.sqlite（側欄真正的資料來源） ----------
async function loadSql() {
  if (SQL) return SQL;
  const initSqlJs = require('sql.js');
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  const wasmBinary = fs.readFileSync(fs.existsSync(wasmPath) ? wasmPath : require.resolve('sql.js/dist/sql-wasm.wasm'));
  SQL = await initSqlJs({ wasmBinary });
  return SQL;
}

async function findStateDb(home) {
  try {
    const files = (await fsp.readdir(home)).filter((f) => /^state_\d+\.sqlite$/.test(f));
    files.sort((a, b) => parseInt(b.match(/\d+/)[0], 10) - parseInt(a.match(/\d+/)[0], 10));
    return files.length ? path.join(home, files[0]) : null;
  } catch { return null; }
}

// Codex 用 WAL 模式，大部分最新資料在 -wal 檔裡；這裡把已提交的 WAL 頁面疊回主檔再交給 sql.js
async function readDbWithWal(dbPath) {
  const db = await fsp.readFile(dbPath);
  let wal = null;
  try { wal = await fsp.readFile(dbPath + '-wal'); } catch { /* 沒有 WAL */ }
  let out = db;
  if (wal && wal.length >= 32) {
    const magic = wal.readUInt32BE(0);
    const pageSize = wal.readUInt32BE(8);
    if ((magic === 0x377f0682 || magic === 0x377f0683) && pageSize >= 512 && pageSize <= 65536) {
      const salt1 = wal.readUInt32BE(16);
      const salt2 = wal.readUInt32BE(20);
      const frameSize = 24 + pageSize;
      const pages = new Map();
      let pending = [];
      let dbPages = Math.floor(db.length / pageSize);
      for (let off = 32; off + frameSize <= wal.length; off += frameSize) {
        if (wal.readUInt32BE(off + 8) !== salt1 || wal.readUInt32BE(off + 12) !== salt2) break;
        pending.push([wal.readUInt32BE(off), off + 24]);
        const commit = wal.readUInt32BE(off + 4);
        if (commit) { for (const [pg, o] of pending) pages.set(pg, o); pending = []; dbPages = commit; }
      }
      if (pages.size) {
        out = Buffer.alloc(dbPages * pageSize);
        db.copy(out, 0, 0, Math.min(db.length, out.length));
        for (const [pg, o] of pages) if (pg >= 1 && pg <= dbPages) wal.copy(out, (pg - 1) * pageSize, o, o + pageSize);
      }
    }
  }
  if (out.length >= 100 && out[18] === 2) { out = Buffer.from(out); out[18] = 1; out[19] = 1; } // 標成非 WAL，讓 sql.js 直接讀
  return out;
}

async function readStateDb(home) {
  const dbPath = await findStateDb(home);
  if (!dbPath) return null;
  try {
    const SQLlib = await loadSql();
    const buf = await readDbWithWal(dbPath);
    const db = new SQLlib.Database(new Uint8Array(buf));
    const cols = new Set();
    const ti = db.exec('PRAGMA table_info(threads)');
    if (!ti.length) { db.close(); return null; }
    for (const row of ti[0].values) cols.add(row[1]);
    const want = ['id', 'rollout_path', 'cwd', 'title', 'name', 'preview', 'first_user_message', 'archived', 'updated_at', 'updated_at_ms',
      'created_at', 'created_at_ms', 'recency_at_ms', 'is_pinned', 'thread_section_id', 'project_id', 'source', 'thread_source',
      'agent_nickname', 'agent_path', 'has_user_event', 'model'];
    const sel = want.filter((c) => cols.has(c));
    const res = db.exec(`SELECT ${sel.join(',')} FROM threads`);
    const threads = [];
    if (res.length) {
      for (const v of res[0].values) {
        const r = {};
        sel.forEach((c, i) => { r[c] = v[i]; });
        threads.push(r);
      }
    }
    const projects = new Map();
    try {
      const pr = db.exec('SELECT p.id, p.name, p.position, r.path FROM projects p LEFT JOIN project_roots r ON r.project_id = p.id AND r.position = 0');
      if (pr.length) for (const [id, name, position, root] of pr[0].values) projects.set(id, { id, name, position, root: normPath(root) });
    } catch { /* 舊版沒有 projects 表 */ }
    db.close();
    return { threads, projects, dbPath };
  } catch (err) {
    return { error: String(err && err.message || err), threads: [], projects: new Map() };
  }
}

function toMs(v) {
  if (v == null) return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) return Date.parse(v) || 0;
  return n < 1e12 ? n * 1000 : n;
}

// ---------- 組合側欄清單 ----------
async function listThreads(opts = {}) {
  const home = codexHome(opts.codexHome);
  const result = { home, available: await exists(home), threads: [], projects: [], dbError: null };
  if (!result.available) return result;

  const [names, state, files] = await Promise.all([
    readSessionIndex(home),
    readStateDb(home),
    (async () => { const out = []; await walkRollouts(path.join(home, 'sessions'), out); await walkRollouts(path.join(home, 'archived_sessions'), out); return out; })(),
  ]);
  if (state && state.error) result.dbError = state.error;

  const byId = new Map();
  const fileById = new Map();
  for (const f of files) {
    const m = path.basename(f).match(ROLLOUT_RE);
    if (m) {
      const id = m[2].toLowerCase();
      if (!fileById.has(id) || f.endsWith('.jsonl')) fileById.set(id, f);
    }
  }

  if (state && state.threads) {
    for (const t of state.threads) {
      const id = String(t.id).toLowerCase();
      const isSub = !!(t.agent_nickname || t.agent_path) || /sub.?agent/i.test(String(t.thread_source || '') + String(t.source || ''));
      const updated = toMs(t.recency_at_ms) || toMs(t.updated_at_ms) || toMs(t.updated_at);
      byId.set(id, {
        id,
        title: names.get(t.id) || stripAppContext(t.name || '') || stripAppContext(t.title || '') || stripAppContext(t.preview || '') || stripAppContext(t.first_user_message || '') || '',
        cwd: normPath(t.cwd),
        projectId: t.project_id || null,
        updatedAt: updated,
        createdAt: toMs(t.created_at_ms) || toMs(t.created_at),
        archived: !!t.archived,
        pinned: !!t.is_pinned || !!t.thread_section_id,
        subagent: isSub,
        empty: t.has_user_event === 0 && !t.preview,
        rolloutPath: fileById.get(id) || normPath(t.rollout_path),
        model: t.model || null,
        missing: !fileById.has(id),
      });
    }
  }

  // 資料庫標成「沒內容」／沒有標題，或可能漏掉內部 agent 標記時，再從紀錄檔確認一次。
  // Zenith worker 的 state DB 目前只寫 source=vscode，唯一可靠標記在 rollout session_meta.originator。
  for (const t of byId.values()) {
    if ((t.empty || !t.title || !t.subagent) && fileById.has(t.id)) {
      const meta = await readSessionMeta(fileById.get(t.id));
      if (meta) {
        if (!t.cwd && meta.cwd) t.cwd = meta.cwd;
        if (meta.isSubagent) t.subagent = true;
        if (meta.hasUser) { t.empty = false; if (!t.title) t.title = meta.firstUser; }
      }
    }
  }

  // 資料庫還沒寫入（WAL）或沒有資料庫時，從檔案補齊
  for (const [id, f] of fileById) {
    const existing = byId.get(id);
    let st;
    try { st = await fsp.stat(f); } catch { continue; }
    if (existing) {
      if (st.mtimeMs > existing.updatedAt) existing.updatedAt = st.mtimeMs;
      continue;
    }
    const meta = await readSessionMeta(f);
    if (!meta) continue;
    byId.set(id, {
      id,
      title: names.get(id) || meta.firstUser || '',
      cwd: meta.cwd,
      projectId: null,
      updatedAt: st.mtimeMs,
      createdAt: Date.parse(meta.createdAt) || st.birthtimeMs,
      archived: f.includes(`${path.sep}archived_sessions${path.sep}`),
      pinned: false,
      subagent: meta.isSubagent,
      empty: !meta.hasUser,
      rolloutPath: f,
      model: null,
    });
  }

  result.threads = [...byId.values()];
  result.projects = state && state.projects ? [...state.projects.values()] : [];
  return result;
}

function stripAppContext(text) {
  if (!text) return '';
  const a = text.indexOf(CTX_OPEN);
  if (a < 0) return text;
  const b = text.indexOf(CTX_CLOSE, a);
  if (b > a) return (text.slice(0, a) + text.slice(b + CTX_CLOSE.length)).trim();
  return text.slice(0, a).trim(); // 預覽被截斷，沒有結尾標記
}

async function resolveRolloutPath(home, id, hint) {
  const candidates = [];
  if (hint) candidates.push(normPath(hint));
  for (const c of [...candidates]) {
    if (c.endsWith('.jsonl')) candidates.push(c + '.zst');
    if (c.endsWith('.zst')) candidates.push(c.slice(0, -4));
  }
  for (const c of candidates) if (c && (await exists(c))) return c;
  const out = [];
  await walkRollouts(path.join(home, 'sessions'), out);
  await walkRollouts(path.join(home, 'archived_sessions'), out);
  const lower = id.toLowerCase();
  const hit = out.filter((f) => f.toLowerCase().includes(lower));
  if (hit.length < 2) return hit[0] || null;
  // 同一執行緒可能有多個紀錄檔（壓縮後接續會另開新檔），取最後更新的那個
  const stats = await Promise.all(hit.map((f) => fsp.stat(f).then((st) => st.mtimeMs, () => 0)));
  const order = hit.map((f, i) => ({ f, t: stats[i] }));
  order.sort((a, b) => b.t - a.t || (a.f.endsWith('.jsonl') ? -1 : 1) - (b.f.endsWith('.jsonl') ? -1 : 1));
  return order[0].f;
}

function shortArgs(s, max = 160) {
  if (s == null) return '';
  let t = typeof s === 'string' ? s : JSON.stringify(s);
  try {
    const o = JSON.parse(t);
    if (o && Array.isArray(o.command)) t = o.command.join(' ');
    else if (o && typeof o.command === 'string') t = o.command;
    else if (o && typeof o.cmd === 'string') t = o.cmd;
  } catch { /* 非 JSON */ }
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

// ---------- 讀取單一執行緒的對話內容 ----------
// Codex 自動塞進對話的系統區塊（環境資訊、AGENTS.md、權限說明…），不是使用者打的字
function isSystemBlock(text) {
  const t = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!t) return true;
  if (/<\/?environment_context>/.test(t)) return true;
  if (/^#\s*AGENTS\.md/i.test(t) || /^<INSTRUCTIONS>/i.test(t)) return true;
  const m = t.match(/^<([a-zA-Z_][\w-]*)(?:\s[^>]*)?>/);
  if (m && t.endsWith(`</${m[1]}>`)) return true; // 整段就是一個 <tag>…</tag> 區塊
  return false;
}

function userTextFromContent(content) {
  const parts = [];
  const images = [];
  for (const c of content || []) {
    if (c.type === 'input_image' || c.type === 'image') { images.push(c.image_url?.url || c.image_url || c.url || c.path || ''); continue; }
    if (typeof c.text === 'string' && !isSystemBlock(c.text)) parts.push(c.text);
  }
  return { text: parts.join('\n').trim(), images };
}

const normText = (t) => stripAppContext(String(t || '')).replace(/\s+/g, ' ').trim();

// 讀取單一執行緒的對話內容
// Codex 不同版本、不同啟動方式（App／exec 新對話／resume）寫入的格式不一樣：
// 有時只有 response_item，有時另外有 event_msg；兩種都讀，再去掉重複。
async function loadTranscript(opts) {
  const home = codexHome(opts.codexHome);
  const file = await resolveRolloutPath(home, opts.id, opts.rolloutPath);
  if (!file) return { messages: [], cwd: '', error: '找不到這個 Codex 執行緒的紀錄檔' };

  const out = [];
  let cwd = '';
  let model = null;
  let pendingTools = [];
  let lastTs = null;
  let turnUsers = new Set();      // 這一輪已經出現過的使用者訊息
  let turnAssistant = new Set();  // 這一輪已經出現過的助理訊息
  let firstMeta = true;

  const pushUser = (text, images, ts) => {
    const refs = Array.isArray(images) ? images : [];
    const count = Array.isArray(images) ? images.length : images;
    const attachments = refs.map((ref,i) => {
      if (typeof ref !== 'string') return null;
      const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-zA-Z0-9+/=\r\n]+)$/.exec(ref);
      if (match) return {name:`圖片 ${i+1}`,mime:match[1],data:match[2]};
      if (/^[a-z]:[\\/]/i.test(ref)) return {name:`圖片 ${i+1}`,mime:'image/png',path:ref};
      return null;
    }).filter(Boolean);
    const clean = stripAppContext(text);
    const key = normText(clean);
    if (!key && !count) return;
    if (key && turnUsers.has(key)) { const previous=out.findLast(m=>m.role==='user'); if(previous && attachments.length && !previous.attachments?.length)previous.attachments=attachments; return; }
    // 新的一輪
    turnUsers = new Set([key]);
    turnAssistant = new Set();
    pendingTools = [];
    out.push({ role: 'user', text: clean + (count ? `\n\n（附圖 ${count} 張）` : ''), attachments, ts, provider: 'codex' });
  };
  const pushAssistant = (text, ts, phase) => {
    const key = normText(text);
    if (!key) return;
    if (turnAssistant.has(key)) return;
    turnAssistant.add(key);
    out.push({ role: 'assistant', text, ts, provider: 'codex', model, tools: pendingTools, phase: phase || null });
    pendingTools = [];
  };

  let lineNumber = 0;
  for await (const line of readLines(file)) {
    lineNumber++;
    if (!line) continue;
    if (line.length > 24_000_000) { if (opts.strict) throw new Error(`Codex 紀錄第 ${lineNumber} 行過大，無法完整匯出`); continue; }
    let obj;
    try { obj = JSON.parse(line); } catch { if (opts.strict) throw new Error(`Codex 紀錄第 ${lineNumber} 行損壞，無法完整匯出`); continue; }
    const ts = obj.timestamp || lastTs;
    if (obj.timestamp) lastTs = obj.timestamp;
    const p = obj.payload || {};
    if (obj.type === 'session_meta') { if (firstMeta || !cwd) cwd = normPath(p.cwd || cwd); firstMeta = false; continue; }
    if (obj.type === 'turn_context') { if (p.model) model = p.model; if (p.cwd) cwd = normPath(p.cwd); turnUsers = new Set(); continue; }
    if (obj.type === 'compacted') { out.push({ role: 'note', text: '（Codex 已壓縮前面的對話內容）', ts }); continue; }
    if (obj.type === 'event_msg') {
      if (p.type === 'user_message') {
        if (!isSystemBlock(p.message) || (p.images && p.images.length)) pushUser(p.message || '', [...(p.images || []), ...(p.local_images || [])], ts);
      } else if (p.type === 'agent_message') {
        pushAssistant(p.message || '', ts, p.phase);
      } else if (p.type === 'agent_reasoning') {
        pushAssistant(p.text || '', ts, 'analysis');
      } else if (p.type === 'task_complete' && p.error && p.error.message) {
        out.push({ role: 'note', text: `（這一輪 Codex 沒有完成：${String(p.error.message).slice(0, 300)}）`, ts });
      }
      continue;
    }
    if (obj.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
        pendingTools.push({ name: p.name || p.type, args: shortArgs(p.arguments || p.input || p.action) });
      } else if (p.type === 'message') {
        if (p.role === 'user') {
          const { text, images } = userTextFromContent(p.content);
          if (text || images) pushUser(text, images, ts);
        } else if (p.role === 'assistant') {
          const text = (p.content || []).map((c) => c.text || '').join('');
          pushAssistant(text, ts, p.phase || p.channel);
        }
      } else if (p.type === 'reasoning') {
        const summary = (p.summary || []).map(c => c.text || '').filter(Boolean).join('\n\n');
        if (summary) pushAssistant(summary, ts, 'analysis');
      }
    }
  }
  if (pendingTools.length) out.push({ role: 'assistant', text: '', ts: lastTs, provider: 'codex', model, tools: pendingTools });
  out.forEach((m, i) => { m.id = `cx-${i}`; m.source = 'codex'; });
  return { messages: out, cwd, file, model };
}

// Codex 的模型清單：優先讀 Codex 自己快取的 models_cache.json
const FALLBACK_CODEX_MODELS = [
  { slug: 'gpt-6-astra', name: 'GPT-6-Astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low' },
  { slug: 'gpt-6-sol', name: 'GPT-6-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium' },
  { slug: 'gpt-6-luna', name: 'GPT-6-Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
  { slug: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low' },
  { slug: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium' },
  { slug: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
  { slug: 'gpt-5.5', name: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
];

async function readCodexModels(override) {
  const home = codexHome(override);
  let defaultModel = null;
  try {
    const cfg = await fsp.readFile(path.join(home, 'config.toml'), 'utf8');
    const m = cfg.match(/^\s*model\s*=\s*"([^"]+)"/m);
    if (m) defaultModel = m[1];
  } catch { /* 沒有 config.toml */ }
  try {
    const j = JSON.parse(await fsp.readFile(path.join(home, 'models_cache.json'), 'utf8'));
    const list = (j.models || [])
      .filter((m) => m && m.slug && (m.visibility === undefined || m.visibility === 'list'))
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
      .map((m) => ({
        slug: m.slug,
        name: m.display_name || m.slug,
        efforts: (m.supported_reasoning_levels || []).map((r) => r.effort || r).filter((e) => typeof e === 'string'),
        defaultEffort: m.default_reasoning_level || null,
      }));
    if (list.length) return { models: list, defaultModel, source: 'cache', clientVersion: j.client_version || '', fetchedAt: Date.parse(j.fetched_at) || 0 };
  } catch { /* 沒有快取 */ }
  return { models: FALLBACK_CODEX_MODELS, defaultModel, source: 'builtin', clientVersion: '', fetchedAt: 0 };
}

// app-server 的 model/list（會向伺服器重新要清單，也會更新 models_cache.json）轉成同樣的格式
function modelsFromAppServer(result) {
  return ((result && result.data) || [])
    .filter((m) => m && (m.id || m.model) && !m.hidden)
    .map((m) => ({
      slug: m.id || m.model,
      name: m.displayName || m.id || m.model,
      efforts: (m.supportedReasoningEfforts || []).map((r) => r.reasoningEffort || r).filter((e) => typeof e === 'string'),
      defaultEffort: m.defaultReasoningEffort || null,
    }));
}

// Codex 伺服器依 CLI 版本決定給哪些模型：快取是舊版 CLI 拿的、或放太久，就該重新取得
const CODEX_MODELS_MAX_AGE = 6 * 3600 * 1000;
function codexModelsStale(cached, cliVersion, now = Date.now()) {
  if (!cached || cached.source !== 'cache') return true;
  const v = String(cliVersion || '').match(/\d+\.\d+\.\d+/);
  if (v && cached.clientVersion && cached.clientVersion !== v[0]) return true;
  return !cached.fetchedAt || now - cached.fetchedAt > CODEX_MODELS_MAX_AGE;
}

// 從最近的 Codex 紀錄檔找最後一次回報的用量（Codex App 每一輪都會記錄）
async function readLatestRateLimits(override) {
  const home = codexHome(override);
  const files = [];
  await walkRollouts(path.join(home, 'sessions'), files);
  const stats = [];
  for (const f of files) { try { stats.push([f, (await fsp.stat(f)).mtimeMs]); } catch { /* */ } }
  stats.sort((a, b) => b[1] - a[1]);
  for (const [f] of stats.slice(0, 8)) {
    if (f.endsWith('.zst')) continue;
    let found = null;
    try {
      for await (const line of readLines(f)) {
        if (!line.includes('"rate_limits"')) continue;
        try {
          const o = JSON.parse(line);
          const rl = o.payload && o.payload.rate_limits;
          if (rl && (rl.primary || rl.secondary)) found = { snapshot: rl, at: Date.parse(o.timestamp) || null };
        } catch { /* */ }
      }
    } catch { /* */ }
    if (found) return found;
  }
  return null;
}

module.exports = { codexHome, listThreads, loadTranscript, stripAppContext, readCodexModels, modelsFromAppServer, codexModelsStale, resolveRolloutPath, readLatestRateLimits, CTX_OPEN, CTX_CLOSE };
