'use strict';
// Prime Agent（PrimeIntellect 的 RLM 代理）以 RPC 模式接進來：
// 指令與事件都是 stdin/stdout 的 JSONL，一行一筆，只用 \n 分隔。
// 文件：https://github.com/PrimeIntellect-ai/prime-agent（packages/coding-agent/docs/rpc.md）
const { spawnCli } = require('./codexRunner');
const fs = require('fs');
const path = require('path');
const os = require('os');

const WIN = process.platform === 'win32';

function responseText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter(v => v?.type === 'text').map(v => responseText(v.text)).join('\n');
  if (value && typeof value === 'object') return responseText(value.text ?? value.content);
  return '';
}

function assistantError(message) {
  if (message?.role !== 'assistant') return '';
  return message.errorMessage || (['error', 'aborted'].includes(message.stopReason) ? `回合${message.stopReason === 'aborted' ? '已中止' : '失敗'}，沒有成功結果` : '');
}

/** get_available_models 回來的清單只留我們要的欄位。 */
function normalizeModels(data) {
  const raw = Array.isArray(data) ? data : (data?.models || []);
  const out = [];
  for (const m of raw) {
    const id = String(m?.id || m?.modelId || '').trim();
    const provider = String(m?.provider || '').trim();
    if (!id || !provider) continue;
    out.push({ provider, id, name: String(m?.name || id) });
  }
  return out;
}

/**
 * 在已知模型清單裡找出使用者／模型指定的那一個。
 * 接受 `id`、`provider/id`、顯示名稱，大小寫不拘；可用 provider 限定。
 */
function matchModel(models, wanted, provider = '') {
  const want = String(wanted || '').trim().toLowerCase();
  if (!want) return null;
  const slash = want.includes('/') ? want.split('/') : null;
  const wantProvider = (slash ? slash[0] : provider || '').trim().toLowerCase();
  const wantId = slash ? slash.slice(1).join('/') : want;
  const pool = wantProvider ? models.filter((m) => m.provider.toLowerCase() === wantProvider) : models;
  return pool.find((m) => m.id.toLowerCase() === wantId)
    || pool.find((m) => m.name.toLowerCase() === wantId)
    || null;
}

/** 供應商在 Prime Agent 眼中有幾個模型可用（0 代表多半是沒有那家的金鑰）。 */
function modelsOf(models, provider) {
  const p = String(provider || '').toLowerCase();
  return models.filter((m) => m.provider.toLowerCase() === p);
}

function candidates(custom) {
  const home = os.homedir();
  const list = [];
  if (custom) list.push(custom);
  const names = WIN ? ['prime-agent.cmd', 'prime-agent.exe', 'prime-agent.ps1', 'prime-agent'] : ['prime-agent'];
  const dirs = [
    path.join(home, '.prime-agent', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'prime-agent', 'bin'),
    path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'prime-agent'),
    path.join(home, 'AppData', 'Roaming', 'npm'),
  ];
  for (const dir of dirs) for (const n of names) list.push(path.join(dir, n));
  // PATH 上的
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir.trim()) continue;
    for (const n of names) list.push(path.join(dir.trim(), n));
  }
  return list;
}

/** 找出可用的 prime-agent 執行檔；找不到回傳 null。 */
function resolveBin(custom) {
  for (const p of candidates(custom)) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 下一個 */ }
  }
  return null;
}

function spawnArgs(bin, extra) {
  // .ps1 要用 PowerShell 跑；.cmd／.bat 與一般執行檔交給 spawnCli 處理
  if (WIN && /\.ps1$/i.test(bin)) return { command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bin, ...extra] };
  return { command: bin, args: extra };
}

/**
 * 開一個 Prime Agent RPC 工作階段。
 * opts: { bin, cwd, provider, model, sessionDir, env, extraArgs }
 */
function createSession(opts = {}) {
  const bin = resolveBin(opts.bin);
  if (!bin) throw new Error('找不到 prime-agent。請先安裝 Prime Agent，或在「API 設定 → 能力擴充」填執行檔路徑。');
  const extra = ['--mode', 'rpc'];
  if (opts.provider) extra.push('--provider', opts.provider);
  if (opts.model) extra.push('--model', opts.model);
  if (opts.sessionDir) { fs.mkdirSync(opts.sessionDir, { recursive: true }); extra.push('--session-dir', opts.sessionDir); }
  else extra.push('--no-session');
  if (Array.isArray(opts.extraArgs)) extra.push(...opts.extraArgs);

  const { command, args } = spawnArgs(bin, extra);
  const child = spawnCli(command, args, {
    cwd: opts.cwd || undefined,
    env: { ...process.env, ...(opts.env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const waiters = new Map();      // 指令回應
  const listeners = new Set();    // 事件訂閱
  let buffer = '';
  let stderr = '';
  let dead = null;
  let seq = 0;

  const fail = (err) => {
    dead = dead || err;
    for (const w of waiters.values()) w.reject(err);
    waiters.clear();
    for (const fn of [...listeners]) { try { fn({ type: '__closed', error: err.message }); } catch { /* 忽略 */ } }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'response') {
        const w = msg.id !== undefined ? waiters.get(msg.id) : null;
        if (w) { waiters.delete(msg.id); msg.success === false ? w.reject(new Error(msg.error || `${msg.command} 被拒絕`)) : w.resolve(msg); }
        continue;
      }
      for (const fn of [...listeners]) { try { fn(msg); } catch { /* 忽略單一訂閱者的錯誤 */ } }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  child.on('error', (e) => fail(new Error(`無法啟動 Prime Agent：${e.message}`)));
  child.on('exit', (code) => fail(new Error(`Prime Agent 已結束（代碼 ${code}）${stderr ? `\n${stderr.trim().slice(-600)}` : ''}`)));

  function command_(type, payload = {}, { timeoutMs = 60000 } = {}) {
    if (dead) return Promise.reject(dead);
    const id = `c${++seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`Prime Agent 的 ${type} 指令超過 ${Math.round(timeoutMs / 1000)} 秒沒有回應`)); }, timeoutMs);
      waiters.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      try { child.stdin.write(JSON.stringify({ id, type, ...payload }) + '\n'); }
      catch (e) { waiters.delete(id); clearTimeout(timer); reject(new Error(`無法送出指令：${e.message}`)); }
    });
  }

  let modelsCache = null;

  return {
    bin,
    get closed() { return !!dead; },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    command: command_,
    /**
     * Prime Agent 這次實際載入的模型清單。
     * 只有「有金鑰的供應商」才會出現在裡面，所以這份清單就是 set_model 的唯一合法範圍。
     */
    async availableModels({ timeoutMs = 20000, force = false } = {}) {
      if (modelsCache && !force) return modelsCache;
      const r = await command_('get_available_models', {}, { timeoutMs });
      modelsCache = normalizeModels(r?.data);
      return modelsCache;
    },
    /** 交一個任務給 Prime Agent，等它整輪做完，回傳最後的文字。 */
    async ask(message, { signal, timeoutMs = 1800000, onDelta, onTool } = {}) {
      if (dead) throw dead;
      if (signal?.aborted) throw new Error('已取消');
      let text = '';
      let turnError = '';
      const tools = [];
      let settle;
      const finished = new Promise((resolve, reject) => { settle = { resolve, reject }; });
      finished.catch(() => {}); // prompt acknowledgement may arrive after cancellation.
      const off = this.on((ev) => {
        if (ev.type === '__closed') { settle.reject(new Error(ev.error)); return; }
        if (ev.type === 'message_update') {
          const d = ev.assistantMessageEvent;
          if (d && d.type === 'text_delta' && typeof d.delta === 'string') { text += d.delta; onDelta && onDelta(d.delta); }
          turnError = assistantError(ev.message) || turnError;
          return;
        }
        if (ev.type === 'tool_execution_start') {
          const name = ev.toolName || ev.tool?.name || ev.name || '工具';
          tools.push(name);
          onTool && onTool(name, ev);
          return;
        }
        if (ev.type === 'message_end') {
          turnError = assistantError(ev.message) || turnError;
          if (ev.message?.role === 'assistant') text = responseText(ev.message.content) || text;
        }
        if (ev.type === 'agent_end') {
          const last = (ev.messages || []).filter(m => m.role === 'assistant').at(-1);
          turnError = assistantError(last) || turnError;
          text = responseText(last?.content) || text;
          settle.resolve();
        }
      });
      const timer = setTimeout(() => { this.abort().catch(() => {}); settle.reject(new Error(`Prime Agent 超過 ${Math.round(timeoutMs / 60000)} 分鐘還沒結束，已送出中止要求`)); }, timeoutMs);
      const onAbort = () => { this.abort().catch(() => {}); settle.reject(new Error('已取消')); };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        try { await command_('prompt', { message }); }
        catch (e) {
          if (!/stream/i.test(e.message)) throw e;
          await command_('prompt', { message, streamingBehavior: 'followUp' });
        }
        await finished;
        if (turnError) {
          const error = new Error(`Prime Agent：${turnError}`);
          error.primeProviderFailure = true;
          throw error;
        }
        if (!text.trim()) {
          // 沒收到串流文字時，直接問它最後一則助理訊息
          const r = await command_('get_last_assistant_text', {}, { timeoutMs: 30000 });
          text = responseText(r?.data);
        }
        if (!text.trim()) throw new Error('Prime Agent 沒有回傳文字結果；請檢查能力擴充中的供應商、模型與 API 額度。');
        return { text: String(text || '').trim(), tools };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        off();
      }
    },
    abort() { return command_('abort', {}, { timeoutMs: 15000 }).catch(() => null); },
    close() {
      fail(new Error('Prime Agent 連線已關閉'));
      try { child.stdin.end(); } catch { /* 已關閉 */ }
      try { child.kill(); } catch { /* 已結束 */ }
      setTimeout(() => { try { if (child.exitCode === null) child.kill('SIGKILL'); } catch { /* 已結束 */ } }, 2000).unref?.();
    },
  };
}

const INSTALL_HINT = 'Prime Agent 安裝方式：到 https://github.com/PrimeIntellect-ai/prime-agent 依說明安裝（安裝後會有 prime-agent 指令），再回到「API 設定 → 能力擴充」按「重新偵測」。';

/** 開一個短命的 RPC 只為了問「你現在有哪些模型」，問完就關掉。設定畫面用。 */
async function probeModels(opts = {}) {
  const session = createSession({ ...opts, sessionDir: '' });
  try { return await session.availableModels({ timeoutMs: opts.timeoutMs || 30000 }); }
  finally { try { session.close(); } catch { /* 已結束 */ } }
}

module.exports = { resolveBin, createSession, probeModels, normalizeModels, matchModel, modelsOf, INSTALL_HINT, responseText, assistantError };
