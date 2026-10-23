// 透過本機 Codex CLI（codex exec --json）執行，沿用 Codex App 的登入與執行緒
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CODEX_AUTH_MESSAGE = 'Codex 登入憑證已失效或被撤銷，已停止重連。請按「重新登入 Codex 帳號」完成授權，再手動接續這段對話；切換舊副本無法恢復已撤銷的 token。';
function isCodexAuthFailure(message) {
  return /refresh_token_(?:invalidated|reused|expired)|token_revoked|invalidated oauth token|workspace routing discovery unauthorized\s*\(401\)|your session has ended|access token could not be refreshed/i.test(String(message || ''));
}
function fileAuthArgs(codexHome) {
  const home = codexHome?.trim() || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return fs.existsSync(path.join(home, 'auth.json')) ? ['-c', 'cli_auth_credentials_store="file"'] : [];
}

const isWin = process.platform === 'win32';
let cachedResolve = null;
let accountChanges = 0;
const accountReaders = new Set();
const activeExecHomes = new Map();
const reviewHomes = new Map();
const homeKey = home => {
  const dir = path.resolve(home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
    const id = auth.tokens?.account_id || JSON.parse(Buffer.from(String(auth.tokens?.id_token || '').split('.')[1] || '', 'base64url').toString()).sub;
    if (id) return 'account:' + require('crypto').createHash('sha256').update(String(id)).digest('hex');
  } catch { /* Anonymous/test homes are keyed by directory. */ }
  return dir.toLowerCase();
};
const reviewWaiters = new Map();
const hasReviewQueue = key => (reviewWaiters.get(key)?.length || 0) > 0;
function reserveKey(key) {
  if (activeExecHomes.get(key) || reviewHomes.has(key)) return null;
  let released = false;
  let resolve;
  const done = new Promise(r => { resolve = r; });
  reviewHomes.set(key, done);
  return () => { if (released) return; released = true; reviewHomes.delete(key); resolve(); };
}
// Fresh access-token snapshots permit parallel review without sharing the
// refresh token. The reviewer must strip refresh credentials and never copy
// its auth back. Expiry alone does not prevent CLI refresh after a server 401.
const MAX_PARALLEL_REVIEWS = 4;
const FRESH_TOKEN_MARGIN_MS = 30 * 60 * 1000;
let parallelReviews = 0;
function authIsFresh(home, now = Date.now()) {
  try {
    const dir = path.resolve(home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
    const auth = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
    const payload = JSON.parse(Buffer.from(String(auth.tokens?.access_token || '').split('.')[1] || '', 'base64url').toString());
    return Number.isFinite(payload.exp) && payload.exp * 1000 > now + FRESH_TOKEN_MARGIN_MS;
  } catch { return false; }
}
function reserveParallelReview(home) {
  if (accountChanges || parallelReviews >= MAX_PARALLEL_REVIEWS || !authIsFresh(home)) return null;
  parallelReviews++;
  let released = false;
  const release = () => { if (released) return; released = true; parallelReviews--; };
  release.parallel = true;
  return release;
}
function reserveReviewHome(home) {
  const key = homeKey(home);
  return hasReviewQueue(key) ? null : reserveKey(key);
}
async function waitForReviewHome(home, { signal, timeoutMs = 60000, onQueue = () => {}, pollMs = 100 } = {}) {
  const key = homeKey(home), ticket = {};
  const queue = reviewWaiters.get(key) || [];
  queue.push(ticket);reviewWaiters.set(key,queue);
  const notify=position=>{try{onQueue(position);}catch{/* status updates must not leak reservations */}};
  const deadline = Date.now() + timeoutMs;
  let position = 0;
  try {
    for (;;) {
      if(signal?.aborted) throw Object.assign(Error('這回合已停止。'),{name:'AbortError'});
      if(position && Date.now() >= deadline) throw Error('排隊等待 Codex 審核超過 '+Math.round(timeoutMs/1000)+' 秒，請手動確認。');
      const release = reserveParallelReview(home) || (queue[0] === ticket ? reserveKey(key) : null);
      if(release){if(position)notify(0);return release;}
      if(Date.now() >= deadline) throw Error('排隊等待 Codex 審核超過 '+Math.round(timeoutMs/1000)+' 秒，請手動確認。');
      const next = queue.indexOf(ticket) + 1;
      if(next !== position){position=next;notify(position);}
      await new Promise(resolve=>{
        const timer=setTimeout(done,Math.max(1,Math.min(pollMs,deadline-Date.now())));
        const abort=()=>done();
        function done(){clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve();}
        signal?.addEventListener('abort',abort,{once:true});
        if(signal?.aborted)done();
      });
    }
  } finally {
    const index=queue.indexOf(ticket);if(index>=0)queue.splice(index,1);
    if(!queue.length && reviewWaiters.get(key)===queue)reviewWaiters.delete(key);
  }
}
function beginAccountChange() { accountChanges++; }
function endAccountChange() { accountChanges = Math.max(0, accountChanges - 1); }
async function waitForAccountReaders(timeoutMs = 25000) {
  let timer;
  try {
    await Promise.race([Promise.all([...accountReaders]), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Codex 帳號查詢尚未結束，登入資料未切換；請稍候重試。')), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}


function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15000, maxBuffer: 4 << 20, ...opts }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function findOnPath(names) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const extra = [];
  if (isWin) {
    if (process.env.APPDATA) extra.push(path.join(process.env.APPDATA, 'npm'));
    if (process.env.LOCALAPPDATA) extra.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'codex'), path.join(process.env.LOCALAPPDATA, 'pnpm'));
    extra.push(path.join(os.homedir(), '.codex', 'bin'), path.join(os.homedir(), 'scoop', 'shims'));
  } else {
    extra.push('/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.local', 'bin'));
  }
  for (const d of [...dirs, ...extra]) {
    for (const n of names) {
      const p = path.join(d, n);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* */ }
    }
  }
  return null;
}

function findFileDeep(root, fileName, depth = 5) {
  if (depth < 0) return null;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) if (e.isFile() && e.name.toLowerCase() === fileName) return path.join(root, e.name);
  for (const e of entries) {
    if (e.isDirectory() && !/^(locales|node_modules\.cache|\.git)$/i.test(e.name)) {
      const hit = findFileDeep(path.join(root, e.name), fileName, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

async function findInCodexStoreApp() {
  if (!isWin) return null;
  const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "(Get-AppxPackage -Name 'OpenAI.Codex*' | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation"]);
  const loc = stdout.trim();
  if (!loc) return null;
  return findFileDeep(loc, 'codex.exe', 5);
}

async function resolveCodex(customPath, force = false) {
  if (customPath && customPath.trim()) {
    const p = customPath.trim().replace(/^"|"$/g, '');
    return { path: p, how: '手動指定' };
  }
  if (cachedResolve && !force) return cachedResolve;
  let found = findOnPath(isWin ? ['codex.exe', 'codex.cmd', 'codex.bat'] : ['codex']);
  let how = 'PATH';
  if (!found) { found = await findInCodexStoreApp(); how = 'Codex App 內建'; }
  cachedResolve = found ? { path: found, how } : { path: null, how: null };
  return cachedResolve;
}

function quoteWinArg(a) {
  if (a === '') return '""';
  if (!/[\s"&|<>^%()]/.test(a)) return a;
  return '"' + a.replace(/"/g, '""') + '"';
}

// npm 安裝的 codex.cmd 只是「node codex.js %*」的包裝。經過 cmd.exe 時，參數裡的
// 引號、| 、括號與空白會被重新解析（例如 -c 帶入的 hook 設定、含空白的路徑），
// 所以找得到 codex.js 時就直接用 node 執行，參數以陣列原樣傳入，不經過 cmd。
function npmShimTarget(exe) {
  const dir = path.dirname(exe);
  const script = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (!/^codex\.cmd$/i.test(path.basename(exe)) || !fs.existsSync(script)) return null;
  const local = path.join(dir, 'node.exe');
  const node = fs.existsSync(local) ? local : findOnPath(['node.exe']);
  return node ? { node, script } : null;
}

function spawnCodex(exe, args, opts) {
  const shim = isWin ? npmShimTarget(exe) : null;
  if (shim) return spawn(shim.node, [shim.script, ...args], { ...opts, windowsHide: true });
  if (isWin && /\.(cmd|bat)$/i.test(exe)) {
    const line = [quoteWinArg(exe), ...args.map(quoteWinArg)].join(' ');
    return spawn(line, { ...opts, shell: true, windowsHide: true });
  }
  return spawn(exe, args, { ...opts, windowsHide: true });
}

async function codexVersion(customPath) {
  const r = await resolveCodex(customPath, true);
  if (!r.path) return { ok: false, message: '找不到 Codex CLI' };
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawnCodex(r.path, ['--version'], {}); } catch (e) { resolve({ ok: false, path: r.path, message: String(e.message) }); return; }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => resolve({ ok: false, path: r.path, message: String(e.message) }));
    child.on('close', (code) => resolve({ ok: code === 0, path: r.path, how: r.how, message: out.trim().split('\n').pop() }));
    setTimeout(() => { try { child.kill(); } catch { /* */ } }, 15000);
  });
}

function killTree(child) {
  if (!child || child.exitCode != null) return;
  if (isWin) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* */ }
  } else {
    try { child.kill('SIGTERM'); } catch { /* */ }
  }
}

/**
 * 執行一次 Codex 回合。
 * handlers: onThread(threadId), onItem(item, phase), onDelta(text), onDone({threadId, usage}), onError(message)
 */
async function runCodex({ customPath, codexHome, prompt, cwd, threadId, sandbox, model, extraArgs, mode, ephemeral, reviewer = false, signal, images = [], extraEnv = null, resolveImpl = resolveCodex, spawnImpl = spawnCodex, killImpl = killTree }, handlers) {
  const r = await resolveImpl(customPath);
  if (!r.path) {
    handlers.onError('找不到 Codex CLI。回到首頁，在 Codex 那一列按「安裝」。');
    return { cancel() {} };
  }
  const args = ['exec', '--json', '--skip-git-repo-check'];
  // auto-review：官方 Auto-review，需要額外權限時交給 Codex 的審核代理判斷（固定工作區寫入沙盒，不能再加 -s）
  if (sandbox === 'auto-review') args.push('--approve-for-me');
  else if (sandbox && ['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox)) args.push('-s', sandbox);
  if (model && model.trim()) args.push('-m', model.trim());
  if (cwd && fs.existsSync(cwd)) args.push('-C', cwd);
  if (ephemeral) args.push('--ephemeral');
  if (Array.isArray(extraArgs)) args.push(...extraArgs);
  args.push(...fileAuthArgs(codexHome));
  if (threadId) args.push(mode === 'fork' ? 'fork' : 'resume', threadId);
  for (const file of images) {
    if (typeof file !== 'string' || !file.trim() || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      handlers.onError('圖片附件缺少有效的檔案路徑，請重新附加圖片後再送出。');
      return { cancel() {} };
    }
    args.push('--image', file);
  }
  args.push('-');

  const env = { ...process.env, ...(extraEnv || {}) };
  if (codexHome && codexHome.trim()) env.CODEX_HOME = codexHome.trim();

  let child;
  const key = homeKey(codexHome);
  const reviewWaitDeadline=Date.now()+60000;
  while (!reviewer && (reviewHomes.has(key) || hasReviewQueue(key))) {
    if (signal?.aborted) { handlers.onDone({ cancelled: true }); return { cancel() {} }; }
    let timer;
    let abort;
    const ready = await Promise.race([(reviewHomes.get(key) || new Promise(resolve=>setTimeout(resolve,100))).then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), Math.max(1,reviewWaitDeadline-Date.now())); }), new Promise(resolve => { abort = () => resolve('cancelled'); signal?.addEventListener('abort', abort, {once:true}); })]);
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (ready === 'cancelled' || signal?.aborted) { handlers.onDone({ cancelled: true }); return { cancel() {} }; }
    if (!ready || Date.now()>=reviewWaitDeadline) { handlers.onError('這個帳號的 Codex 操作審核尚未結束，請稍候或重新啟動 App 後再試。'); return { cancel() {} }; }
  }
  if (signal?.aborted) { handlers.onDone({ cancelled: true }); return { cancel() {} }; }
  activeExecHomes.set(key, (activeExecHomes.get(key) || 0) + 1);
  let released = false;
  const releaseHome = () => { if (released) return; released = true; const n = (activeExecHomes.get(key) || 1) - 1; if (n) activeExecHomes.set(key, n); else activeExecHomes.delete(key); };
  try {
    child = spawnImpl(r.path, args, { cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(), env });
  } catch (e) {
    releaseHome();
    handlers.onError(`無法啟動 Codex：${e.message}`);
    return { cancel() {} };
  }

  const closed = new Promise(resolve => { child.once('close', resolve); child.once('error', resolve); });
  closed.then(releaseHome);
  let stdoutBuf = '';
  let stderrTail = '';
  let currentThread = threadId || null;
  let usage = null;
  let failed = null;
  let lastError = null;
  let sawOutput = false;
  let cancelled = false;
  let authFailed = false;
  let ended = false;
  const finish = (method, ...args) => {
    if (ended) return; ended = true;
    Promise.resolve().then(() => handlers[method](...args)).catch(error => console.error('Codex 回合收尾失敗：',error.message));
  };
  const stopInvalidAuth = (message) => {
    if (!authFailed && isCodexAuthFailure(message)) { authFailed = true; finish('onError',CODEX_AUTH_MESSAGE,{authRequired:true,sawOutput}); killImpl(child); }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (ended) return;
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line.startsWith('{')) continue;
      if (ended) break;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      stopInvalidAuth(ev.message || ev.error?.message || ev.item?.message);
      if (authFailed) continue;
      switch (ev.type) {
        case 'thread.started':
          currentThread = ev.thread_id || currentThread;
          handlers.onThread(currentThread);
          break;
        case 'item.started':
        case 'item.updated':
        case 'item.completed':
          if (ev.item && ev.item.type === 'error' && isBenignCodexWarning(ev.item.message)) break;
          if (ev.item && ev.item.type !== 'error') sawOutput = true;
          if (ev.item) handlers.onItem(ev.item, ev.type.split('.')[1]);
          break;
        case 'turn.completed':
          usage = ev.usage || null;
          break;
        case 'turn.failed':
          failed = (ev.error && ev.error.message) || 'Codex 回合失敗';
          finish('onError',failed + (stderrTail ? `\n\n${stderrTail.trim().slice(-1200)}` : ''),{writerConflict:/already has an active writer/i.test(failed + stderrTail),sawOutput});
          killImpl(child);
          break;
        case 'error':
          if (isBenignCodexWarning(ev.message)) break;
          // 「Reconnecting... 2/5」這類是暫時性訊息，不代表這一輪失敗
          lastError = ev.message || 'Codex 發生錯誤';
          if (handlers.onNotice) handlers.onNotice(lastError);
          break;
        default:
          break;
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-4000); stopInvalidAuth(stderrTail); });
  child.stdin.on('error', () => { /* 子程序提早結束 */ });
  child.stdin.end(prompt, 'utf8');

  child.on('error', (e) => finish('onError',`無法啟動 Codex：${e.message}`));
  child.on('close', (code) => {
    if (ended) return;
    if (authFailed) { finish('onError',CODEX_AUTH_MESSAGE, { authRequired: true, sawOutput }); return; }
    if (cancelled) { finish('onDone',{ threadId: currentThread, usage, cancelled: true }); return; }
    const combined = `${failed || ''}\n${lastError || ''}\n${stderrTail}`;
    const info = { writerConflict: /already has an active writer/i.test(combined), sawOutput };
    if (failed) { finish('onError',failed + (stderrTail ? `\n\n${stderrTail.trim().slice(-1200)}` : ''), info); return; }
    if (code !== 0 && /unexpected argument '--approve-for-me'/i.test(stderrTail)) { finish('onError','這版 Codex CLI 不支援「自動審核（Auto-review）」。請更新 Codex CLI，或把使用權限改回「預設權限」。', info); return; }
    if (code !== 0) { finish('onError',(lastError ? `${lastError}\n\n` : '') + `Codex 結束代碼 ${code}` + (stderrTail ? `\n\n${stderrTail.trim().slice(-1500)}` : ''), info); return; }
    finish('onDone',{ threadId: currentThread, usage });
  });

  return { closed, cancel() { if (ended) return; cancelled = true; finish('onDone',{threadId:currentThread,usage,cancelled:true}); killImpl(child); } };
}

function installCodexCli(onLog) {
  return new Promise((resolve) => {
    const npm = findOnPath(isWin ? ['npm.cmd'] : ['npm']);
    if (!npm) { resolve({ ok: false, message: '這台電腦沒有 npm（Node.js）。請先安裝 Node.js LTS（https://nodejs.org），再按一次安裝。' }); return; }
    const child = spawnCodex(npm, ['install', '-g', '@openai/codex@latest'], {});
    child.stdout.on('data', (d) => onLog(String(d)));
    child.stderr.on('data', (d) => onLog(String(d)));
    child.on('error', (e) => resolve({ ok: false, message: e.message }));
    child.on('close', (code) => { cachedResolve = null; resolve({ ok: code === 0, message: code === 0 ? '安裝完成' : `npm 結束代碼 ${code}` }); });
  });
}

// ---- 官方 app-server（JSON-RPC over stdio）：改名、封存、查用量都走這裡，Codex App 會看到同樣的結果 ----
async function appServerCall(customPath, codexHome, calls, timeoutMs = 20000) {
  const r = await resolveCodex(customPath);
  if (!r.path) throw new Error('找不到 Codex CLI');
  const env = { ...process.env };
  if (codexHome && codexHome.trim()) env.CODEX_HOME = codexHome.trim();
  if (accountChanges) throw new Error('正在切換 Codex 帳號，稍後再讀取用量或執行帳號查詢。');
  const key = homeKey(codexHome);
  if (reviewHomes.has(key) || hasReviewQueue(key)) throw new Error('Codex 正在審核操作，稍後再查詢帳號。');
  activeExecHomes.set(key, (activeExecHomes.get(key) || 0) + 1);
  let child;
  const releaseHome = () => { const n = (activeExecHomes.get(key) || 1) - 1; if (n) activeExecHomes.set(key, n); else activeExecHomes.delete(key); };
  try { child = spawnCodex(r.path, ['app-server', ...fileAuthArgs(codexHome)], { env, cwd: os.homedir() }); }
  catch (error) { releaseHome(); throw error; }
  const closed = new Promise((resolve) => { child.once('close', resolve); child.once('error', resolve); });
  closed.then(releaseHome);
  accountReaders.add(closed);
  closed.finally(() => accountReaders.delete(closed));
  let buf = '';
  let nextId = 0;
  const pending = new Map();
  let stderrTail = '';
  const fail = (err) => { for (const p of pending.values()) p.reject(err); pending.clear(); };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) { const message = msg.error.message || JSON.stringify(msg.error); p.reject(new Error(isCodexAuthFailure(message) ? CODEX_AUTH_MESSAGE : message)); }
        else p.resolve(msg.result);
      }
    }
  });
  child.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-2000); if (isCodexAuthFailure(stderrTail)) { fail(new Error(CODEX_AUTH_MESSAGE)); killTree(child); } });
  child.on('error', (e) => fail(e));
  child.on('close', () => fail(new Error(`Codex app-server 已結束${stderrTail ? `：${stderrTail.trim().split('\n').pop()}` : ''}`)));
  child.stdin.on('error', () => {});
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const timer = setTimeout(() => fail(new Error('Codex app-server 沒有回應')), timeoutMs);
  try {
    await call('initialize', { clientInfo: { name: 'codex_multi', title: 'Codex 多模型工作台', version: '1.6.0' } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const results = [];
    for (const [method, params] of calls) results.push(await call(method, params));
    return results;
  } finally {
    clearTimeout(timer);
    try { child.stdin.end(); } catch { /* */ }
    setTimeout(() => killTree(child), 300);
  }
}

// Codex CLI 把設定警告也用 error 項目回報：Codex 桌面版寫進 config.toml、CLI 不認得的鍵，
// 以及刪除保護用的 --dangerously-bypass-hook-trust 提醒。這些不影響執行，不應顯示成「錯誤」。
function isBenignCodexWarning(msg) {
  const m = String(msg || '');
  return /is ignoring \d+ unrecognized configuration setting/i.test(m) || /--dangerously-bypass-hook-trust.{0,20}is enabled/i.test(m);
}

module.exports = { authIsFresh, waitForReviewHome, reserveReviewHome, beginAccountChange, endAccountChange, waitForAccountReaders, isCodexAuthFailure, fileAuthArgs, CODEX_AUTH_MESSAGE, isBenignCodexWarning, resolveCodex, runCodex, codexVersion, installCodexCli, appServerCall, findOnPath, spawnCli: spawnCodex, killTree };
