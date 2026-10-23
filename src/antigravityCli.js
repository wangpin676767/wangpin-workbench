'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os');
const { spawn, execFile } = require('child_process');
const { killTree } = require('./codexRunner');
const legacy = require('./antigravity');
const AGENT = 'codex-multi-bridge';
const AGENT_TEXT = `---\nname: ${AGENT}\ndescription: Codex Multi controlled tool transport\nmainAgent: true\nsubagent: false\ntools: [finish]\ncommandExecutionPolicy: off\n---\nAnswer the user's request in Traditional Chinese. Local tools are supplied by the host through explicit tool schemas. Use those tool tags when instructed. Do not use finish for intermediate steps. Never invent tool results.\n`;
function cliPath() {
  const dirs = [path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin'), path.join(os.homedir(), '.local', 'bin'), ...String(process.env.PATH || '').split(path.delimiter)];
  return dirs.map(d => path.join(d, process.platform === 'win32' ? 'agy.exe' : 'agy')).find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || '';
}
function missing() { const e = new Error('尚未安裝 Antigravity CLI。請在帳號選單按「安裝 CLI」。'); e.notInstalled = true; return e; }
function exec(args, timeout = 45000) {
  const file = cliPath(); if (!file) return Promise.reject(missing());
  return new Promise((resolve, reject) => execFile(file, args, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) return reject(new Error(String(stderr || stdout || err.message).slice(-1800)));
    resolve(String(stdout || ''));
  }));
}
function parseModels(text, quotas = []) {
  const { buckets, windows, findQuotaGroup } = require('./antigravityQuota');
  const models = String(text).split(/\r?\n/).flatMap(line => {
    const m = /^([\w.-]+)\t(.+)$/.exec(line.trim()); if (!m) return [];
    const { family, effort } = legacy.splitLabel(m[2]);
    const bucket = findQuotaGroup(quotas, family);
    const validBuckets = (bucket?.buckets || []).filter(b => !b.disabled && typeof b.remaining_fraction === 'number' && Number.isFinite(b.remaining_fraction) && b.remaining_fraction >= 0 && b.remaining_fraction <= 1);
    return [{ id: m[1], modelId: m[1], label: m[2], family, effort, remaining: validBuckets.length ? Math.min(...validBuckets.map(b => b.remaining_fraction)) : null, quotaGroup: bucket?.name || '', quotaBuckets: buckets(quotas, family), quotaWindows: windows(quotas, family), resetTime: '', images: /^(?:Claude|Gemini)\s/i.test(family) }];
  });
  if (!models.length) throw new Error('Antigravity CLI 沒有回傳模型清單；請先登入 CLI');
  const families = [];
  for (const m of models) { let f = families.find(f => f.name === m.family); if (!f) families.push(f = { name: m.family, variants: [] }); f.variants.push(m); }
  const rank = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };
  for (const f of families) f.variants.sort((a, b) => (rank[a.effort] ?? 9) - (rank[b.effort] ?? 9));
  return { models, families };
}

let cachedStatus = null;
let cachedTime = 0;
let inFlightStatus = null;
let statusEpoch = 0;

function clearCache() {
  ++statusEpoch;
  cachedStatus = null;
  cachedTime = 0;
  inFlightStatus = null;
}

async function status({ execCommand = exec, force = false, cache = (execCommand === exec), metadataTimeoutMs = 25000 } = {}) {
  const now = Date.now();
  if (!force && cache && cachedStatus && (now - cachedTime < 60000)) {
    return cachedStatus;
  }
  if (cache && inFlightStatus) {
    return inFlightStatus;
  }
  const epoch = ++statusEpoch;
  const task = (async () => {
    const optional = async args => {
      let timer;
      try {
        const text = await Promise.race([
          execCommand(args, metadataTimeoutMs),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('額度／預設模型查詢逾時；模型仍可使用')), metadataTimeoutMs); })
        ]);
        const data = JSON.parse(text);
        if (data.status !== 'SUCCESS') throw new Error(data.error || 'CLI 查詢失敗');
        return { data };
      } catch (error) {
        return { error: String(error.message).slice(-500) };
      } finally {
        clearTimeout(timer);
      }
    };
    // `models` fails fast without a browser when signed out; print-mode queries
    // would instead start an interactive OAuth flow and open stray sign-in tabs.
    const text = await execCommand(['models']);
    const [usage, current] = await Promise.all([
      optional(['-p', '/usage', '--output-format', 'json', '--print-timeout', '30s']),
      optional(['-p', '/model', '--output-format', 'json', '--print-timeout', '30s']),
    ]);
    const groups = usage.data?.command?.data?.groups || (cachedStatus?.quotaGroups || []);
    const parsed = parseModels(text, groups);
    // Models are required to send; quota/default-model metadata is optional.
    const res = {
      ok: true,
      fetchedAt: Date.now(),
      via: 'cli',
      account: { email: '', name: 'Antigravity CLI', plan: '', tier: '' },
      defaultModel: current.data?.command?.data?.id || (cachedStatus?.defaultModel || ''),
      usageError: usage.error || '',
      modelError: current.error || '',
      quotaGroups: groups,
      ...parsed
    };
    if (cache && epoch === statusEpoch) {
      cachedStatus = res;
      cachedTime = Date.now();
    }
    return res;
  })();
  if (cache) {
    inFlightStatus = task;
    task.then(() => { if (inFlightStatus === task) inFlightStatus = null; }, () => { if (inFlightStatus === task) inFlightStatus = null; });
  }
  return task;
}
let installing;
function install() {
  if (installing) return installing;
  installing = new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'vendor', 'agy-install.ps1'), '--skip-aliases', '--skip-path'], { windowsHide: true, timeout: 10 * 60000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error || !cliPath()) reject(new Error(String(stderr || stdout || error?.message || 'CLI 安裝失敗').slice(-1800)));
    else resolve();
  })).finally(() => { installing = null; });
  return installing;
}
function level(permission) {
  const levels = { default: 'workspace-write', 'codex-review': 'workspace-write', chat: 'chat', plan: 'read-only', acceptEdits: 'workspace-write', bypassPermissions: 'danger-full-access' };
  if (!Object.hasOwn(levels, permission)) throw new Error('不支援的 Antigravity 權限');
  return levels[permission];
}
async function execute(name, args, permission, context) {
  const mode = level(permission);
  const kit = require('./apiTools');
  const allowed = kit.definitions(mode, { browser: !!context.browser, braveBrowser: !!context.braveBrowser, approval: 'on-request' });
  if (!allowed.some(t => t.function.name === name)) throw new Error('目前權限禁止此工具');
  if (permission === 'default' && name === 'write_file' && !(await context.approve?.({ kind: 'write', detail: String(args.path) }))) throw new Error('使用者未同意寫入檔案');
  return kit.execute(name, args, { ...context, mode, approval: 'on-request' });
}
function prepare() {
  const file = path.join(os.homedir(), '.gemini', 'config', 'agents', AGENT, 'agent.md');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, AGENT_TEXT, 'utf8');
}
function ask({ model, prompt, images = [], signal, cwd, onDelta = () => {}, onStatus = () => {}, onTool = () => {}, timeout = 30 * 60000 }) {
  const file = cliPath(); if (!file) return Promise.reject(missing());
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('已停止'), { name: 'AbortError' }));
  if (images.length) return askImages({ model, prompt, images, signal, cwd, onDelta, onStatus, onTool, timeout });
  prepare();
  // CLI has no direct filesystem/shell tools in this custom agent. Host enforces all tool permissions.
  return new Promise((resolve, reject) => {
    const child = spawn(file, ['--input-format', 'stream-json', '--output-format', 'stream-json', '--agent', AGENT, '--disable-slash-commands', '--model', model], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = ''; let stderr = ''; let result; let settled = false;
    const abort = () => { killTree(child); finish(Object.assign(new Error('已停止'), { name: 'AbortError' })); };
    const timer = setTimeout(() => { killTree(child); finish(new Error('Antigravity CLI 回覆逾時')); }, timeout);
    function finish(error) { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(result.response); }
    signal?.addEventListener('abort', abort, { once: true });
    function line(text) {
      let ev; try { ev = JSON.parse(text); } catch { return; }
      if (ev.event === 'step_update') {
        const s = ev.step_update || {};
        if (s.step_type === 'agent_response' && s.text_delta) onDelta(s.text_delta);
        if (s.step_type === 'tool') onStatus(`Antigravity CLI：${s.tool_name || '工具進度'}`);
      }
      if (ev.event === 'result') result = ev.result;
    }
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { buffer += chunk; let i; while ((i = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, i)); buffer = buffer.slice(i + 1); } if (buffer.length > 8 * 1024 * 1024) { killTree(child); finish(new Error('CLI 輸出過大')); } });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', finish); child.stdin.on('error', e => { if (e.code !== 'EPIPE') finish(e); });
    child.on('close', code => { if (buffer.trim()) line(buffer); if (signal?.aborted) return abort();
      if (code !== 0 || result?.status !== 'SUCCESS' || typeof result?.response !== 'string') return finish(new Error(result?.error || stderr || `Antigravity CLI 結束但未完成回覆（${code}）`)); finish(); });
    child.stdin.end(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n');
  });
}
async function askImages({ model, prompt, images, signal, cwd, onDelta, onStatus, onTool, timeout }) {
  const agent = require('./antigravityAgent');
  const vision = require('./antigravityImages');
  const name = 'codex-multi-image-chat';
  const config = path.join(os.homedir(), '.gemini', 'config', 'agents', name, 'agent.md');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, `---\nname: ${name}\ndescription: Codex Multi attachment image transport\nmainAgent: true\nsubagent: false\ntools: [view_file, finish]\ncommandExecutionPolicy: off\n---\nAnswer in Traditional Chinese. You may use view_file only to view images attached to this conversation. All other local tools are supplied by the host through explicit tool schemas. Never invent tool results.\n`, 'utf8');
  // A separate workspace per invocation keeps hooks scoped even when conversations run concurrently.
  const workspace = agent.prepareWorkspace(path.join(cwd, 'image-runs', require('crypto').randomUUID()));
  const hook = await agent.startHookServer(vision.reader(images, () => !!signal?.aborted));
  try {
    const result = await agent.run({ cli: cliPath(), model, prompt: prompt + vision.instruction(images), workspace, agentName: name,
      env: hook.env, signal, timeout, onDelta, onTool: tool => { onTool(tool); onStatus(`Antigravity CLI：${tool.name === 'view_file' ? '讀取附件圖片' : tool.name}`); } });
    return result.text;
  } finally { hook.close(); }
}
module.exports = { cliPath, parseModels, status, clearCache, ask, install, level, execute, resolveModel: legacy.resolveModel };
