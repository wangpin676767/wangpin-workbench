// 透過本機 Claude Code CLI（claude -p，stream-json）使用 Claude 訂閱，不走 Claude API
const fs = require('fs');
const path = require('path');
const os = require('os');
const { findOnPath, spawnCli, killTree } = require('./codexRunner');

const isWin = process.platform === 'win32';
let cached = null;
let activeLogin = null;

// 擴充工具（代理任務、Zenith 的 advance_project）本來就會跑幾十分鐘，
// 但 Claude Code 的 MCP 工具預設一分鐘就放棄。呼叫端放棄之後工作台這邊還在跑，
// 使用者看到的就是「任務逾時」外加後續每一次交付都被鎖住，所以這裡要放到跟工具上限同級。
const MCP_TOOL_TIMEOUT_MS = 65 * 60 * 1000;

function cliEnv(configDir) {
  const env = { ...process.env };
  if (configDir && configDir.trim()) env.CLAUDE_CONFIG_DIR = path.resolve(configDir.trim());
  if (!env.MCP_TOOL_TIMEOUT) env.MCP_TOOL_TIMEOUT = String(MCP_TOOL_TIMEOUT_MS);
  // 閒置逾時（多久沒有任何回應或進度就放棄）預設只有 300 秒，另外調到同級；橋接層也會定期送進度
  if (!env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT) env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT = String(MCP_TOOL_TIMEOUT_MS);
  if (!env.MCP_TIMEOUT) env.MCP_TIMEOUT = String(30000);
  return env;
}

function extraDirs() {
  const home = os.homedir();
  if (isWin) {
    return [
      path.join(home, '.local', 'bin'),
      process.env.APPDATA && path.join(process.env.APPDATA, 'npm'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'claude'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'AnthropicClaude'),
      path.join(home, '.claude', 'local'),
    ].filter(Boolean);
  }
  return [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), '/usr/local/bin', '/opt/homebrew/bin'];
}

// Desktop 更新後可能把 CLI 放在版本下的 payload/hash 資料夾；只查這兩層，
// 不遞迴掃描桌面版的快取或工作階段，也不把桌面版 UI 執行檔當成 CLI。
function findDesktopCli(roots) {
  for (const root of roots.filter(Boolean)) {
    let versions;
    try { versions = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); }
    catch { continue; }
    for (const version of versions) {
      const dir = path.join(root, version);
      const direct = path.join(dir, 'claude.exe');
      try { if (fs.statSync(direct).isFile()) return direct; } catch {}
      let payloads;
      try { payloads = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort().reverse(); }
      catch { continue; }
      for (const payload of payloads) {
        const file = path.join(dir, payload, 'claude.exe');
        try { if (fs.statSync(file).isFile()) return file; } catch {}
      }
    }
  }
  return null;
}

function resolveClaude(customPath, force = false) {
  if (customPath && customPath.trim()) return { path: customPath.trim().replace(/^"|"$/g, ''), how: '手動指定' };
  if (cached?.path && !force && fs.existsSync(cached.path)) return cached;
  const names = isWin ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude'];
  let found = findOnPath(names);
  if (!found) {
    for (const d of extraDirs()) {
      for (const n of names) {
        const p = path.join(d, n);
        try { if (fs.statSync(p).isFile()) { found = p; break; } } catch { /* */ }
      }
      if (found) break;
    }
  }
  if (!found && isWin) {
    const roots = [process.env.APPDATA && path.join(process.env.APPDATA, 'Claude', 'claude-code')];
    const local = process.env.LOCALAPPDATA;
    if (local) {
      try { for (const name of fs.readdirSync(path.join(local, 'Packages'))) if (name.startsWith('Claude_')) roots.push(path.join(local, 'Packages', name, 'LocalCache', 'Roaming', 'Claude', 'claude-code')); } catch {}
    }
    found = findDesktopCli(roots);
  }
  cached = found ? { path: found, how: /[\\/]Claude[\\/]claude-code[\\/]/i.test(found) ? 'Claude 桌面版內建 CLI' : 'CLI' } : { path: null };
  return cached;
}

function claudeVersion(customPath) {
  const r = resolveClaude(customPath, true);
  if (!r.path) return Promise.resolve({ ok: false, message: '找不到 Claude Code' });
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawnCli(r.path, ['--version'], {}); } catch (e) { resolve({ ok: false, path: r.path, message: e.message }); return; }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => resolve({ ok: false, path: r.path, message: e.message }));
    child.on('close', (code) => resolve({ ok: code === 0, path: r.path, message: out.trim().split('\n').pop() }));
    setTimeout(() => { try { child.kill(); } catch { /* */ } }, 15000);
  });
}

const BASE_ARGS = ['-p', '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--tools', '', '--no-session-persistence'];

function chatDir() {
  const d = path.join(os.tmpdir(), 'codex-multi-claude');
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* */ }
  return d;
}

function lineReader(stream, onLine) {
  let buf = '';
  const consume = (line) => {
    if (!line.trim().startsWith('{')) return;
    let value;
    try { value = JSON.parse(line); } catch { return; }
    onLine(value);
  };
  stream.setEncoding('utf8');
  stream.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      consume(line);
    }
  });
  stream.on('end', () => { if (buf.trim()) consume(buf); buf = ''; });
}

// 官方控制指令：get_usage（方案用量）、list_models（可用模型）
async function control(customPath, requests, timeoutMs = 25000, configDir = '', extraEnv = null) {
  const r = resolveClaude(customPath);
  if (!r.path) throw new Error('找不到 Claude Code');
  const child = spawnCli(r.path, BASE_ARGS, { cwd: chatDir(), env: { ...cliEnv(configDir), ...(extraEnv || {}) } });
  const pending = new Map();
  let stderrTail = '';
  const fail = (err) => { for (const p of pending.values()) p.reject(err); pending.clear(); };
  lineReader(child.stdout, (o) => {
    if (o.type !== 'control_response' || !o.response) return;
    const p = pending.get(o.response.request_id);
    if (!p) return;
    pending.delete(o.response.request_id);
    if (o.response.subtype === 'success') p.resolve(o.response.response);
    else p.reject(new Error(o.response.error || 'Claude Code 回傳錯誤'));
  });
  child.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-1500); });
  child.on('error', (e) => fail(e));
  child.on('close', () => fail(new Error(`Claude Code 已結束${stderrTail ? `：${stderrTail.trim().split('\n').pop()}` : ''}`)));
  child.stdin.on('error', () => {});
  const timer = setTimeout(() => fail(new Error('Claude Code 沒有回應')), timeoutMs);
  try {
    const results = [];
    for (const [i, req] of requests.entries()) {
      const id = `cm_${Date.now()}_${i}`;
      const pr = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      child.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request: req }) + '\n');
      results.push(await pr);
    }
    return results;
  } finally {
    clearTimeout(timer);
    try { child.stdin.end(); } catch { /* */ }
    setTimeout(() => killTree(child), 300);
  }
}

/**
 * 問一次 Claude（工具依使用者權限模式開放，不另存 CLI 對話紀錄）。
 * handlers: onDelta(text), onReasoning(text), onModel(model), onRateLimit(info), onDone({usage, cost}), onError(message)
 */
function runChat({ customPath, model, effort, system, prompt, cwd, configDir = '', permission = 'default', onPermission, mcpConfig, disallowTools = [], settingsFile = '', extraEnv = null, chrome = false, pureText = false, resolveImpl = resolveClaude, spawnImpl = spawnCli, killImpl = killTree }, handlers) {
  if (pureText) { permission = 'chat'; chrome = false; mcpConfig = null; settingsFile = ''; onPermission = null; }
  handlers = { onDelta() {}, onReasoning() {}, onModel() {}, onRateLimit() {}, onDone() {}, onError() {}, ...handlers };
  const r = resolveImpl(customPath);
  if (!r.path) {
    handlers.onError('找不到 Claude Code。請先在這台電腦安裝並登入 Claude Code，或到「API 設定」改用 Claude API 金鑰。');
    return { cancel() {} };
  }
  const args = BASE_ARGS.filter((v, i) => v !== '--tools' && BASE_ARGS[i - 1] !== '--tools');
  args.push('--include-partial-messages');
  if (pureText) args.push('--safe-mode', '--no-chrome', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--setting-sources', '', '--permission-prompts', 'none');
  if (mcpConfig) args.push('--mcp-config',JSON.stringify(mcpConfig));
  if (settingsFile) args.push('--settings', settingsFile);
  // Brave 裡的 Claude 官方擴充：用使用者自己的瀏覽器與登入（CLI 也會順便更新擴充的本機連線程式路徑）
  if (chrome && permission !== 'chat') args.push('--chrome');
  if (permission === 'chat') args.push('--tools', '');
  else args.push('--permission-mode', ['default', 'plan', 'acceptEdits', 'auto', 'bypassPermissions'].includes(permission) ? permission : 'default');
  // auto：Claude Code 的自動審核模式；被審核擋下而需要詢問的操作，一樣交給 App 的同意卡
  if (permission === 'default' || permission === 'acceptEdits' || permission === 'plan' || permission === 'auto') args.push('--permission-prompt-tool', 'stdio');
  if (model && model.trim()) args.push('--model', model.trim());
  if (effort && effort !== 'default' && /^[a-z]+$/.test(effort)) args.push('--effort', effort);
  if (system && system.trim()) args.push('--append-system-prompt', system.trim().replace(/\s*\n\s*/g, ' '));
  // 使用者勾了能力擴充時，把 Claude 內建的同類工具關掉，否則它常常改用自己的 WebFetch，
  // 擴充就等於白勾了。這是可變長度參數，放在最後才不會吃掉後面的旗標。
  if (Array.isArray(disallowTools) && disallowTools.length) args.push('--disallowedTools', ...disallowTools);

  let child;
  try {
    child = spawnImpl(r.path, args, { cwd: cwd && fs.existsSync(cwd) ? cwd : chatDir(), env: { ...cliEnv(configDir), ...(extraEnv || {}) } });
  } catch (e) {
    handlers.onError(`無法啟動 Claude Code：${e.message}`);
    return { cancel() {} };
  }
  let gotDelta = false;
  const closed = new Promise(resolve => { child.once('close', resolve); child.once('error', resolve); });
  let finished = false;
  let cancelled = false;
  let stderrTail = '';
  const finish = (fn) => {
    if (finished) return; finished = true;
    try { Promise.resolve(fn()).catch(error=>console.error('Claude 回合收尾失敗：',error.message)); }
    catch(error) { console.error('Claude 回合收尾失敗：',error.message); }
    try { child.stdin.end(); } catch { /* */ }
  };

  lineReader(child.stdout, (o) => {
    if (finished || cancelled) return;
    if (o.type === 'control_request' && o.request?.subtype === 'can_use_tool') {
      Promise.resolve().then(() => onPermission ? onPermission(o.request.tool_name, o.request.input) : false).catch(() => false).then(allow => {
        if (finished || cancelled) return;
        child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: allow ? { behavior: 'allow', updatedInput: o.request.input } : { behavior: 'deny', message: '使用者拒絕工具操作' } } }) + '\n');
      }).catch((e) => { finish(() => handlers.onError(`無法回覆 Claude 工具權限：${e.message}`)); killTree(child); });
      return;
    }
    switch (o.type) {
      case 'system':
        if (o.subtype === 'init' && o.model) handlers.onModel(String(o.model).replace(/\[1m\]$/, ''));
        break;
      case 'stream_event': {
        const ev = o.event || {};
        if (ev.type === 'message_start') {
          gotDelta = false;
          if (ev.message && ev.message.model) handlers.onModel(ev.message.model);
        }
        if (ev.type === 'content_block_delta' && ev.delta) {
          if (ev.delta.type === 'text_delta') { gotDelta = true; handlers.onDelta(ev.delta.text); }
          else if (ev.delta.type === 'thinking_delta') handlers.onReasoning(ev.delta.thinking);
        }
        break;
      }
      case 'assistant':
        if (o.error) {
          const detail = (o.message?.content || []).filter(c=>c.type === 'text').map(c=>c.text).join('\n');
          finish(()=>handlers.onError(detail || (typeof o.error === 'string' ? o.error : o.error.message) || 'Claude Code 回傳錯誤'));
          killImpl(child); break;
        }
        if (!gotDelta && o.message && Array.isArray(o.message.content)) {
          const text = o.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
          if (text && !o.error) handlers.onDelta(text);
        }
        if (o.message && o.message.model && o.message.model !== '<synthetic>') handlers.onModel(o.message.model);
        gotDelta = false;
        break;
      case 'rate_limit_event':
        if (o.rate_limit_info) handlers.onRateLimit(o.rate_limit_info);
        break;
      case 'result':
        if (o.is_error) {
          const msg = String(o.result || (o.errors || []).join('\n') || 'Claude Code 回傳錯誤');
          finish(() => handlers.onError(/not logged in|\/login/i.test(msg) ? `這個 app 啟動的獨立 Claude CLI 尚未取得授權，不代表你的 Claude 桌面版已登出。\n請到「API 設定 → 其他設定 → 檢查 Claude 連線」確認使用的執行檔與設定資料夾。若終端機已登入，選擇相同的設定資料夾；若只在桌面版 Code 分頁登入，可用「連接 Claude 帳號」在既有瀏覽器登入狀態下完成 CLI 授權。\n若你已在 Claude 桌面版登入，按「沿用 Claude 桌面版登入」即可直接沿用，不必重新授權。\n目前設定位置：${cliEnv(configDir).CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')}` : msg));
        } else {
          finish(() => handlers.onDone({ usage: o.usage || null, cost: o.total_cost_usd }));
        }
        break;
      default:
        break;
    }
  });
  child.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-2000); });
  child.stdin.on('error', () => {});
  child.on('error', (e) => finish(() => handlers.onError(`無法啟動 Claude Code：${e.message}`)));
  child.on('close', (code) => {
    if (cancelled) finish(() => handlers.onDone({ cancelled: true }));
    else finish(() => handlers.onError(`Claude Code 提早結束（代碼 ${code}）${stderrTail ? `\n${stderrTail.trim().slice(-800)}` : ''}`));
  });

  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '' }) + '\n');
  return { closed, cancel() { if (finished) return; cancelled = true; finish(() => handlers.onDone({ cancelled: true })); killImpl(child); } };
}

function authStatus(customPath, configDir = '', options = {}) {
  const r = resolveClaude(customPath, true);
  const env = cliEnv(configDir);
  const configDirectory = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const base = { path: r.path, source: r.how, configDirectory };
  if (!r.path) return Promise.resolve({ ...base, ok: false, loggedIn: null, message: '找不到 Claude Code 執行檔' });
  return new Promise(resolve => {
    let child; let output = ''; let done = false; let timer;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); resolve({ ...base, ...value }); };
    try { child = (options.spawnCli || spawnCli)(r.path, ['auth', 'status', '--json'], { env, cwd: chatDir() }); }
    catch (e) { finish({ ok: false, loggedIn: null, message: e.message }); return; }
    timer = setTimeout(() => { (options.killTree || killTree)(child); finish({ ok: false, loggedIn: null, message: '檢查連線逾時' }); }, options.timeoutMs || 15000);
    child.stdout.on('data', d => { output = (output + d).slice(-20000); });
    child.stderr.on('data', () => {});
    child.on('error', e => finish({ ok: false, loggedIn: null, message: e.message }));
    child.on('close', code => {
      try {
        const data = JSON.parse(output);
        if (typeof data.loggedIn !== 'boolean' || (code !== 0 && !(code === 1 && data.loggedIn === false))) {
          finish({ ok: false, loggedIn: null, message: `Claude 登入狀態查詢未完成（代碼 ${code}）` }); return;
        }
        const safe = {};
        for (const key of ['authMethod', 'email', 'orgId', 'orgName', 'subscriptionType']) {
          if (typeof data[key] === 'string') safe[key] = data[key].slice(0, 300);
        }
        finish({ ...safe, ok: true, loggedIn: data.loggedIn, configDirectory: typeof data.configDirectory === 'string' ? data.configDirectory : configDirectory,
          message: data.loggedIn ? '此 CLI 已登入，可直接沿用' : '這個 Claude CLI 設定尚未登入；可重新登入，或選擇已有登入的 Claude 帳號' });
      }
      catch { finish({ ok: false, loggedIn: null, message: 'CLI 沒有回傳可辨識的登入狀態，請檢查執行檔版本' }); }
    });
    child.stdin.end();
  });
}

function login(customPath, configDir = '', onURL = () => {}, options = {}) {
  if (activeLogin) return Promise.resolve({ ok: false, message: '已有一個授權流程進行中' });
  const r = resolveClaude(customPath, true);
  if (!r.path) return Promise.resolve({ ok: false, message: '找不到 Claude Code，請先指定執行檔路徑。' });
  return new Promise(resolve => {
    let child;
    try { child = (options.spawnCli || spawnCli)(r.path, ['auth', 'login', '--claudeai'], { env: cliEnv(configDir), cwd: chatDir() }); }
    catch (e) { resolve({ ok: false, message: `無法啟動 Claude 登入：${e.message}` }); return; }
    let output = ''; let done = false;
    const finish = result => { if (done) return; done = true; clearTimeout(timer); activeLogin = null; try { child.stdin.end(); } catch {} resolve(result); };
    const stop = options.killTree || killTree;
    const timer = setTimeout(() => { stop(child); finish({ ok: false, cancelled: true, message: '登入逾時，請重新按登入按鈕。' }); }, options.timeoutMs || 300000);
    activeLogin = { child, cancel: () => { stop(child); finish({ ok: false, cancelled: true, message: '已取消授權' }); } };
    const seen = new Set();
    const collect = d => {
      if (done) return;
      output = (output + d).slice(-16000);
      for (const match of output.matchAll(/https:\/\/[^\s\u001b<>]+/g)) {
        try { const url = new URL(match[0]); if (['claude.ai', 'platform.claude.com', 'console.anthropic.com'].includes(url.hostname) && /oauth|authorize/i.test(url.pathname) && !seen.has(url.href)) { seen.add(url.href); onURL(url.href); } } catch {}
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', e => finish({ ok: false, message: e.message }));
    child.on('close', code => finish({ ok: code === 0, message: code === 0 ? 'Claude CLI 授權完成，可以開始聊天' : '授權未完成；請檢查瀏覽器，若顯示授權碼可貼到此處。' }));
    child.stdin.on('error', () => {});
  });
}
function submitLoginCode(code) {
  if (!activeLogin) return { ok: false, message: '請先開始連接 Claude 帳號' };
  if (typeof code !== 'string' || code.length > 4096 || /[\r\n\0]/.test(code) || !code.trim()) return { ok: false, message: '授權碼格式無效' };
  try { activeLogin.child.stdin.write(code.trim() + '\n'); return { ok: true, message: '授權碼已送出' }; }
  catch { return { ok: false, message: '登入流程已結束，請重新開始連接 Claude 帳號。' }; }
}
function cancelLogin() { activeLogin?.cancel(); return { ok: true }; }
module.exports = { resolveClaude, findDesktopCli, claudeVersion, control, runChat, login, authStatus, cliEnv, submitLoginCode, cancelLogin, MCP_TOOL_TIMEOUT_MS };
