'use strict';
// Grok Build（xAI 官方 grok CLI）透過 ACP（Agent Client Protocol，JSON-RPC over stdio）接入工作台。
// 每回合啟動一次 `grok agent --no-leader stdio`：initialize → session/load（接續）或 session/new →
// session/prompt；回答經 session/update 串流回來。CLI 用一般「詢問」權限模式啟動（不開 always-approve），
// 寫檔、執行指令等操作都會以 session/request_permission 回頭問工作台；工作台依權限設定決定，
// 任何沒回答、解析失敗或停止的情況一律拒絕。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');

const PERMISSIONS = ['read-only', 'ask', 'full'];
const STATUS_TTL = 60 * 1000;
let statusCache = null;

function cliPath() {
  const home = process.env.USERPROFILE || os.homedir();
  const candidates = [process.env.GROK_BIN_DIR && path.join(process.env.GROK_BIN_DIR, 'grok.exe'), path.join(home, '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok')].filter(Boolean);
  return candidates.find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } }) || '';
}
function grokHome() { return process.env.GROK_HOME || path.join(process.env.USERPROFILE || os.homedir(), '.grok'); }
function signedIn() {
  try { const stat = fs.statSync(path.join(grokHome(), 'auth.json')); return stat.isFile() && stat.size > 2; } catch { return false; }
}
function authSignature() {
  try {
    const file=path.join(grokHome(),'auth.json'),s=fs.statSync(file);
    if(s.size<=1024*1024){
      const data=JSON.parse(fs.readFileSync(file,'utf8'));
      const identities=Object.entries(data).map(([scope,v])=>[scope,v?.user_id,v?.principal_id,v?.team_id,v?.auth_mode]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
      if(identities.length && identities.every(row=>typeof row[1]==='string' && row[1]))return crypto.createHash('sha256').update(JSON.stringify(identities)).digest('hex');
    }
    return `${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  } catch { return 'missing'; }
}
function level(value) { return PERMISSIONS.includes(value) ? value : 'ask'; }

// Only the host-created, per-run browser bridge can be injected here. Never
// accept an arbitrary MCP process, remote endpoint or user-supplied header.
function browserServers(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1) throw new Error('Grok Build 瀏覽器橋接設定無效');
  return value.map(server => {
    let url;
    try { url = new URL(server?.url); } catch { throw new Error('Grok Build 瀏覽器橋接設定無效'); }
    const headers = server?.headers;
    if (server.type !== 'http' || server.name !== 'app_browser' || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/mcp' || url.search || url.hash || url.username || url.password ||
        !Array.isArray(headers) || headers.length !== 1 || headers[0]?.name !== 'Authorization' || !/^Bearer [a-f0-9]{64}$/.test(headers[0]?.value || '')) throw new Error('Grok Build 瀏覽器橋接設定無效');
    return { type: 'http', name: 'app_browser', url: url.href, headers: [{ name: 'Authorization', value: headers[0].value }] };
  });
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else { try { child.kill('SIGKILL'); } catch {} }
}

/** 一條 ACP 連線。onRequest(method, params) 處理 agent → client 的請求；onNotify(method, params) 處理通知。 */
function connect({ cli, args, cwd, env, onRequest, onNotify, onExit }) {
  const child = spawn(cli, args, { cwd, env: { ...process.env, ...(env || {}) }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 0, buffer = '', stderr = '', closed = false;
  const fail = error => {
    if (closed) return;
    closed = true;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
    onExit?.(error);
  };
  const write = message => { if (!closed && child.stdin.writable) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 64 * 1024 * 1024) { fail(new Error('Grok Build 輸出異常（單行過長）')); killTree(child); return; }
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.method && message.id !== undefined) {
        Promise.resolve().then(() => onRequest(message.method, message.params || {}))
          .then(result => write({ id: message.id, result: result ?? null }))
          .catch(error => write({ id: message.id, error: { code: error.code || -32603, message: String(error.message || error) } }));
      } else if (message.method) {
        try { onNotify(message.method, message.params || {}); } catch {}
      } else if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(Object.assign(new Error(message.error.message || 'Grok Build 回傳錯誤'), { code: message.error.code, data: message.error.data }));
        else resolve(message.result);
      }
    }
  });
  child.on('error', error => fail(error));
  child.on('exit', code => fail(Object.assign(new Error(`Grok Build 已結束（代碼 ${code}）${stderr.trim() ? `：${stderr.trim().split(/\r?\n/).slice(-3).join(' ')}` : ''}`), { exitCode: code })));
  return {
    child,
    request(method, params) {
      if (closed) return Promise.reject(new Error('Grok Build 連線已關閉'));
      const id = ++nextId;
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); write({ id, method, params }); });
    },
    notify(method, params) { write({ method, params }); },
    close() { fail(Object.assign(new Error('Grok Build 連線已關閉'), { closed: true })); try { child.stdin.end(); } catch {} killTree(child); },
    get stderr() { return stderr; },
  };
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}

const unsupported = method => Object.assign(new Error(`工作台不支援 ${method}`), { code: -32601 });

function modelsOf(init) {
  const state = init?._meta?.modelState || {};
  const models = (state.availableModels || []).map(m => ({
    id: String(m.modelId || ''), name: String(m.name || m.modelId || ''), description: String(m.description || ''),
    efforts: (m._meta?.reasoningEfforts || []).map(e => ({ id: String(e.id || e.value), label: String(e.label || e.id), default: e.default === true })),
    contextTokens: Number(m._meta?.totalContextTokens) || 0,
  })).filter(m => m.id);
  return { models, current: String(state.currentModelId || models[0]?.id || '') };
}

function normalizeBilling(value) {
  const c=value?.config;
  if (!c || typeof c!=='object' || Array.isArray(c)) throw new Error('未提供方案額度');
  const cents=v=>v && typeof v==='object' && !Array.isArray(v) && (v.val===undefined || Number.isSafeInteger(v.val)) && (v.val??0)>=0 ? (v.val??0)/100 : null;
  let usedPercent=typeof c.creditUsagePercent==='number' && Number.isFinite(c.creditUsagePercent) && c.creditUsagePercent>=0 && c.creditUsagePercent<=100 ? c.creditUsagePercent : null;
  let legacy=false;
  if(c.creditUsagePercent==null){const limit=cents(c.monthlyLimit),used=cents(c.used);if(limit>0 && used!==null){usedPercent=Math.min(100,used/limit*100);legacy=true;}}
  const period=c.currentPeriod?.type==='USAGE_PERIOD_TYPE_WEEKLY'?'weekly':c.currentPeriod?.type==='USAGE_PERIOD_TYPE_MONTHLY'||legacy?'monthly':'unknown';
  const end=c.currentPeriod?.end ?? c.billingPeriodEnd;
  return {usedPercent,remainingPercent:usedPercent===null?null:100-usedPercent,period,
    resetAt:typeof end==='string' && Number.isFinite(Date.parse(end))?new Date(end).toISOString():null,
    plan:typeof value.subscription_tier==='string'?value.subscription_tier.slice(0,100):'',
    prepaidUsd:cents(c.prepaidBalance),source:'live',at:Date.now()};
}
async function readQuota(conn) {
  return normalizeBilling(await withTimeout(conn.request('_x.ai/billing',{}),20000,'額度查詢逾時'));
}

/** 只讀取登入、模型與官方 billing 額度；不建立對話、不送出 prompt。 */
async function status({ force = false } = {}) {
  const cli = cliPath();
  if (!cli) return { ok: false, installed: false, signedIn: false, models: [], message: '尚未安裝 Grok Build CLI' };
  const identity=authSignature();
  if (!force && statusCache && Date.now() - statusCache.at < STATUS_TTL && statusCache.cli === cli && statusCache.identity===identity) return statusCache.result;
  const conn = connect({ cli, args: ['agent', '--no-leader', 'stdio'], cwd: os.tmpdir(), onRequest: async method => { throw unsupported(method); }, onNotify: () => {} });
  try {
    const init = await withTimeout(conn.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }), 30000, 'Grok Build 啟動逾時');
    const { models, current } = modelsOf(init);
    const loggedIn = signedIn();
    let quota=null,quotaError='';
    if(loggedIn){try{quota=await readQuota(conn);}catch{quotaError='額度暫時無法讀取；點一下重試（不影響聊天）。';}}
    const result = { ok: loggedIn, installed: true, signedIn: loggedIn, version: String(init?._meta?.agentVersion || ''), models, current,quota,quotaError,
      loadSession: init?.agentCapabilities?.loadSession === true, message: loggedIn ? '' : '尚未登入 Grok Build（grok.com 帳號）' };
    if(identity!==authSignature())return {...result,ok:false,models:[],current:'',signedIn:signedIn(),quota:null,quotaError:'帳號已切換，請重新讀取額度。'};
    if(!quotaError)statusCache = { at: Date.now(), cli, identity, result };
    return result;
  } finally { conn.close(); }
}
function clearCache() { statusCache = null; }

function textOf(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(textOf).join('');
  if (content.type === 'text') return String(content.text || '');
  if (content.content) return textOf(content.content);
  return '';
}

/**
 * 執行一回合。decide(toolCall) 回傳 true（允許一次）或 false（拒絕）。
 * 回傳 { text, sessionId, stopReason }；失敗時丟出的錯誤帶 streamed／sessionId。
 */
async function run({ cli, cliArgs = [], requireSignIn = true, cwd, model, effort, prompt, sessionId, signal, decide, onDelta, onThought, onTool, onStatus, mcpServers }) {
  const browserMcp = browserServers(mcpServers);
  if (!cli) throw new Error('尚未安裝 Grok Build CLI。請在帳號選單按「安裝 Grok Build CLI」。');
  if (requireSignIn && !signedIn()) throw Object.assign(new Error('尚未登入 Grok Build：請在帳號選單按「登入 Grok Build」，在瀏覽器完成 grok.com 登入。'), { code: 'GROKBUILD_LOGIN' });
  let streamed = '', currentSession = '', loading = false, settled = false;
  const tools = new Map();
  const args = [...cliArgs, 'agent', '--no-leader'];
  if (model) args.push('-m', model);
  args.push('stdio');
  let exitError = null;
  const conn = connect({
    cli, args, cwd,
    onRequest: async (method, params) => {
      if (method !== 'session/request_permission') throw unsupported(method);
      const options = Array.isArray(params.options) ? params.options : [];
      const allow = options.find(o => o.kind === 'allow_once') || options.find(o => /^allow/.test(o.kind || ''));
      const reject = options.find(o => o.kind === 'reject_once') || options.find(o => /^reject/.test(o.kind || ''));
      let ok = false;
      if (!settled && !signal?.aborted && allow) {
        try { ok = (await decide(params.toolCall || {})) === true; } catch { ok = false; }
      }
      if (signal?.aborted || settled) return { outcome: { outcome: 'cancelled' } };
      if (ok) return { outcome: { outcome: 'selected', optionId: allow.optionId } };
      return reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : { outcome: { outcome: 'cancelled' } };
    },
    onNotify: (method, params) => {
      if (method !== 'session/update' || loading || (currentSession && params.sessionId && params.sessionId !== currentSession)) return;
      const update = params.update || {};
      const kind = update.sessionUpdate;
      if (kind === 'agent_message_chunk') { const t = textOf(update.content); if (t) { streamed += t; onDelta?.(t); } }
      else if (kind === 'agent_thought_chunk') { const t = textOf(update.content); if (t) onThought?.(t); }
      else if (kind === 'tool_call' || kind === 'tool_call_update') {
        const previous = tools.get(update.toolCallId) || {};
        const next = { ...previous, ...Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined && v !== null)) };
        tools.set(update.toolCallId, next);
        onTool?.(next);
      }
    },
    onExit: error => { exitError = error; },
  });
  const abort = () => {
    if (currentSession) conn.notify('session/cancel', { sessionId: currentSession });
    setTimeout(() => conn.close(), 3000);
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw Object.assign(new Error('已停止'), { name: 'AbortError' });
    onStatus?.('正在啟動 Grok Build…');
    const init = await withTimeout(conn.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }), 60000, 'Grok Build 啟動逾時');
    if (browserMcp.length && init?.agentCapabilities?.mcpCapabilities?.http !== true) throw new Error('目前 Grok Build CLI 不支援工作台所需的 HTTP MCP 瀏覽器橋接，請更新 CLI。');
    if (signal?.aborted) throw Object.assign(new Error('已停止'), { name: 'AbortError' });
    let resumed = false;
    if (sessionId && init?.agentCapabilities?.loadSession) {
      loading = true;
      try { await withTimeout(conn.request('session/load', { sessionId, cwd, mcpServers: browserMcp }), 120000, '接續 Grok Build 對話逾時'); currentSession = sessionId; resumed = true; }
      catch { /* 舊 session 不見了：開新的 */ }
      finally { loading = false; }
    }
    if (!resumed) {
      if (signal?.aborted) throw Object.assign(new Error('已停止'), { name: 'AbortError' });
      const created = await withTimeout(conn.request('session/new', { cwd, mcpServers: browserMcp }), 120000, '建立 Grok Build 對話逾時');
      currentSession = String(created?.sessionId || '');
      if (!currentSession) throw new Error('Grok Build 沒有回傳對話 ID');
    }
    if (effort && effort !== 'default') {
      try { await withTimeout(conn.request('session/set_config_option', { sessionId: currentSession, configId: 'reasoning_effort', value: effort }), 15000, 'timeout'); }
      catch { try { await withTimeout(conn.request('session/set_config_option', { sessionId: currentSession, configId: 'reasoning_effort', value: { value: effort } }), 15000, 'timeout'); } catch { onStatus?.(`這個模型不接受推理強度「${effort}」，改用預設。`); } }
    }
    if (signal?.aborted) throw Object.assign(new Error('已停止'), { name: 'AbortError' });
    onStatus?.('Grok Build 正在處理…');
    const result = await conn.request('session/prompt', { sessionId: currentSession, prompt: [{ type: 'text', text: prompt }] });
    settled = true;
    const stopReason = String(result?.stopReason || '');
    if (signal?.aborted || stopReason === 'cancelled') throw Object.assign(new Error('已停止'), { name: 'AbortError' });
    if (stopReason === 'refusal') throw new Error('Grok Build 拒絕回答這個請求（refusal）。');
    return { text: streamed, sessionId: currentSession, resumed, stopReason, tools: [...tools.values()] };
  } catch (error) {
    settled = true;
    const failure = signal?.aborted ? Object.assign(new Error('已停止'), { name: 'AbortError' }) : (exitError && error === exitError ? exitError : error);
    // CLI diagnostics can echo connection arguments. Do not let ephemeral
    // capability URLs or credentials enter persisted assistant error text.
    for (const server of browserMcp) {
      for (const secret of [server.url, server.headers[0].value, server.headers[0].value.slice(7)]) failure.message = String(failure.message).split(secret).join('[瀏覽器橋接已隱藏]');
    }
    if (/auth|unauthori[sz]ed|sign.?in|log.?in|401/i.test(String(failure.message)) && failure.name !== 'AbortError') failure.message = `Grok Build 登入失效或尚未登入：${failure.message}\n請在帳號選單按「登入 Grok Build」。`;
    failure.streamed = streamed; failure.sessionId = currentSession;
    throw failure;
  } finally {
    signal?.removeEventListener('abort', abort);
    conn.close();
  }
}

/** 在可見的主控台視窗執行 `grok login`（瀏覽器 OAuth 由使用者完成）。 */
async function openLogin() {
  const cli = cliPath();
  if (!cli) throw new Error('尚未安裝 Grok Build CLI');
  clearCache();
  // cmd/start interprets its own quotes and titles rather than Windows argv.
  // Keep the executable and fixed login argument separate; encode only the
  // PowerShell launcher so Unicode, spaces and apostrophes remain literal.
  const literal = value => "'" + value.replace(/'/g, "''") + "'";
  const home = process.env.USERPROFILE || os.homedir();
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    `$p = Start-Process -FilePath ${literal(cli)} -ArgumentList @('login') -WorkingDirectory ${literal(home)} -WindowStyle Normal -PassThru`,
    '[Console]::WriteLine((@{pid=$p.Id} | ConvertTo-Json -Compress))',
  ].join('\r\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const started = await new Promise((resolve, reject) => execFile(powershell,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { windowsHide: true, timeout: 15000, maxBuffer: 32768, encoding: 'utf8' },
    (error, stdout) => {
      if (error) { reject(new Error('無法啟動 Grok Build 登入視窗，請確認 CLI 路徑與 Windows PowerShell 可用。')); return; }
      try {
        const result = JSON.parse(stdout.trim());
        if (!Number.isInteger(result.pid) || result.pid <= 0) throw new Error('invalid pid');
        resolve(result);
      } catch { reject(new Error('Grok Build 登入啟動器未回報成功，請重新嘗試。')); }
    }));
  return { ok: true, pid: started.pid, message: '已啟動 grok login；請在瀏覽器完成 grok.com 登入，回到工作台後重新讀取帳號狀態。' };
}

/** 用官方安裝腳本（https://x.ai/cli/install.ps1）在可見的 PowerShell 視窗安裝；不在背景靜默執行。 */
function openInstall() {
  clearCache();
  const script = "irm https://x.ai/cli/install.ps1 | iex; Write-Host ''; Write-Host '安裝完成後可關閉此視窗，回到工作台按「重新讀取」。'; Read-Host '按 Enter 關閉'";
  const child = spawn('cmd.exe', ['/d', '/c', 'start', '"安裝 Grok Build CLI"', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return { ok: true, message: '已開啟官方安裝視窗（x.ai/cli/install.ps1）。完成後回到工作台按「重新讀取」。' };
}

/** 依權限設定決定一次工具操作。isDelete(toolCall) 判斷是否為刪除；ask(detail, kind) 跳同意卡。 */
async function decideTool(toolCall, { permission, planOnly, noDelete, isDelete, ask }) {
  if (planOnly || permission === 'read-only') return false;
  const deleting = isDelete(toolCall);
  if (permission === 'full' && !(noDelete && deleting)) return true;
  return (await ask(deleting ? 'delete' : 'tool')) === true;
}

module.exports = { cliPath, signedIn, status, clearCache, run, openLogin, openInstall, level, decideTool, modelsOf, textOf, connect, normalizeBilling, readQuota, browserServers, PERMISSIONS };
