'use strict';
// Google Antigravity：透過使用者電腦上正在執行的 Antigravity 本機服務（language_server）對話。
// 用的是 Antigravity 裡已登入的 Google 帳號與它的模型額度，不需要 API 金鑰；
// 本模組只連 127.0.0.1，不自行登入、不保存 Google 憑證。
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const SERVICE = 'exa.language_server_pb.LanguageServerService';
let cached = null; // { port, csrf, pid }
let discovering = null;

function run(file, args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout || '')));
  });
}

// 從行程命令列取出 CSRF token；只接受 Antigravity 自己的 language_server
function parseProcesses(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^(\d+)\t(.*)$/.exec(line.trim());
    if (!m || !/antigravity/i.test(m[2])) continue;
    const csrf = /--csrf_token[= ](\S+)/.exec(m[2]);
    if (csrf) out.push({ pid: Number(m[1]), csrf: csrf[1].replace(/^"|"$/g, '') });
  }
  return out;
}
function parseListening(text, pid) {
  const ports = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || !/^TCP$/i.test(cols[0]) || !/LISTEN/i.test(cols[3]) || Number(cols[4]) !== pid) continue;
    const m = /^(?:127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d+)$/.exec(cols[1]);
    if (m) ports.add(Number(m[1]));
  }
  return [...ports].sort((a, b) => a - b);
}

async function call(conn, method, body, { signal, timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(`http://127.0.0.1:${conn.port}/${SERVICE}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Codeium-Csrf-Token': conn.csrf },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON（例如 HTTPS 埠的錯誤訊息） */ }
    if (!res.ok || !json) {
      const e = new Error(json?.message || text.slice(0, 200) || `HTTP ${res.status}`);
      e.status = res.status; e.code = json?.code;
      throw e;
    }
    return json;
  } catch (e) {
    if (signal?.aborted) { const a = new Error('已停止'); a.name = 'AbortError'; throw a; }
    if (e.name === 'AbortError') { const t = new Error('Antigravity 沒有在時間內回應'); t.timeout = true; throw t; }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function discover() {
  if (process.platform !== 'win32') throw new Error('Antigravity 連線目前只支援 Windows');
  const ps = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='language_server.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"]);
  const procs = parseProcesses(ps);
  if (!procs.length) throw notRunning();
  const netstat = await run('netstat.exe', ['-ano', '-p', 'TCP']);
  for (const p of procs) {
    for (const port of parseListening(netstat, p.pid)) {
      const conn = { port, csrf: p.csrf, pid: p.pid };
      try { await call(conn, 'GetUserStatus', {}, { timeout: 15000 }); return conn; } catch { /* 下一個埠 */ }
    }
  }
  throw notRunning();
}
function notRunning() {
  const e = new Error('找不到執行中的 Antigravity。請先開啟 Antigravity 並登入 Google 帳號，再重試。');
  e.notRunning = true;
  return e;
}

// 連線資訊會因為 Antigravity 重開而改變：失敗時重新尋找一次
async function withConn(fn) {
  if (cached) {
    try { return await fn(cached); } catch (e) {
      if (e.name === 'AbortError' || e.timeout || (e.status && e.status < 500 && e.status !== 401 && e.status !== 403 && e.code !== 'unauthenticated')) throw e;
      cached = null;
    }
  }
  // 同時有好幾個請求（切換分頁＋開選單）時只找一次
  cached = await (discovering || (discovering = discover().finally(() => { discovering = null; })));
  return fn(cached);
}

const EFFORT_RE = /\s*\((minimal|low|medium|high|xhigh|max)\)\s*$/i;
function splitLabel(label) {
  const m = EFFORT_RE.exec(String(label || ''));
  return m ? { family: label.slice(0, m.index).trim(), effort: m[1].toLowerCase() } : { family: String(label || '').trim(), effort: '' };
}

function parseStatus(json) {
  const us = json?.userStatus || {};
  const data = us.cascadeModelConfigData || {};
  const order = new Map();
  (data.clientModelSorts?.[0]?.groups || []).flatMap((g) => g.modelLabels || []).forEach((l, i) => order.set(l, i));
  const models = (data.clientModelConfigs || []).filter((c) => c?.modelOrAlias?.model).map((c) => {
    const { family, effort } = splitLabel(c.label);
    return {
      id: c.modelOrAlias.model, modelId: c.modelId || '', label: c.label || c.modelId, family, effort,
      images: !!c.supportsImages, recommended: !!c.isRecommended, tag: c.tagTitle || '',
      remaining: typeof c.quotaInfo?.remainingFraction === 'number' ? c.quotaInfo.remainingFraction : null,
      resetTime: c.quotaInfo?.resetTime || '',
    };
  }).sort((a, b) => (order.get(a.label) ?? 999) - (order.get(b.label) ?? 999));
  const families = [];
  for (const m of models) {
    let f = families.find((x) => x.name === m.family);
    if (!f) families.push(f = { name: m.family, variants: [] });
    f.variants.push(m);
  }
  const RANK = { minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
  for (const f of families) f.variants.sort((a, b) => (RANK[a.effort] ?? 9) - (RANK[b.effort] ?? 9));
  const plan = us.planStatus?.planInfo?.planName || '';
  return {
    ok: true,
    account: { email: us.email || '', name: us.name || '', plan, tier: us.userTier?.name || '' },
    defaultModel: data.defaultOverrideModelConfig?.modelOrAlias?.model || '',
    models, families,
  };
}

async function status() {
  return parseStatus(await withConn((c) => call(c, 'GetUserStatus', {}, { timeout: 20000 })));
}

/** 依使用者選的模型家族＋推理強度找出 Antigravity 的模型代號。effort 為 default 時用「中」，沒有中就用最接近的。 */
function resolveModel(st, family, effort) {
  const fam = st.families.find((f) => f.name === family) || (family ? null : (st.families.find((f) => f.variants.some((v) => v.id === st.defaultModel)) || st.families[0]));
  if (!fam) {
    const e = new Error(`你的 Antigravity 帳號目前沒有「${family}」，請在模型選單重新選擇。`);
    e.badModel = true;
    throw e;
  }
  const want = effort && effort !== 'default' ? effort : '';
  const pick = (want && fam.variants.find((v) => v.effort === want))
    || (!family && fam.variants.find((v) => v.id === st.defaultModel))
    || fam.variants.find((v) => v.effort === 'medium')
    || fam.variants.find((v) => v.effort === 'high')
    || fam.variants[0];
  return { family: fam.name, variant: pick, effortMissing: !!want && pick.effort !== want };
}

async function ask({ model, prompt, signal, timeout = 15 * 60 * 1000 }) {
  const r = await withConn((c) => call(c, 'GetModelResponse', { prompt, model }, { signal, timeout }));
  if (typeof r.response !== 'string') throw new Error('Antigravity 沒有回傳文字');
  return r.response;
}

function exePath() {
  const local = process.env.LOCALAPPDATA || '';
  return [path.join(local, 'Programs', 'Antigravity', 'Antigravity.exe'), path.join(local, 'Programs', 'antigravity', 'Antigravity.exe')].find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || '';
}

module.exports = { parseProcesses, parseListening, parseStatus, splitLabel, resolveModel, status, ask, exePath, _reset: () => { cached = null; } };
