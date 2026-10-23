'use strict';
// Antigravity CLI 原生代理：讓 agy 用自己的工具（讀寫檔、執行指令、瀏覽器）操作電腦，
// 跟 Antigravity App 裡一樣；權限由工作台把關。
//
// 做法：agy 用 --dangerously-skip-permissions 跑（headless 模式沒辦法跳詢問，不跳就會被自動拒絕），
// 再在中繼工作區放一份 .agents/hooks.json，PreToolUse hook 把每一次工具呼叫交回工作台判斷：
// 依權限模式直接放行、擋下，或跳同意卡問使用者。刪除保護也在這裡套用。
// 使用者的專案用 --add-dir 加進工作區，不在專案裡留下任何設定檔。
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { killTree } = require('./codexRunner');
const deleteGuard = require('./deleteGuard');

const HOOK_SCRIPT = path.join(__dirname, 'agyHook.js');
const HOOK_TIMEOUT_SEC = 520; // 排隊300秒＋審核45秒＋同意卡120秒＋啟動／清理餘裕
const AGY_DATA = path.join(require('os').homedir(), '.gemini', 'antigravity-cli', 'brain');

// 只讀、不改電腦狀態的工具：除了「僅聊天」都放行
const READ_TOOLS = new Set(['view_file', 'list_dir', 'find_by_name', 'grep_search', 'search_web', 'read_url_content', 'command_status',
  'list_permissions', 'list_resources', 'read_resource', 'ask_question', 'ask_permission', 'ask_custom_permission', 'finish', 'wait', 'wait_5_seconds',
  'manage_task', 'list_plugin_accounts', 'search_marketplace', 'invoke_subagent', 'define_subagent', 'manage_subagents', 'send_message', 'manage_inbox', 'generate_image']);
// 會改檔案內容的工具
const WRITE_TOOLS = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content', 'sed_file', 'notebook_edit']);
// Antigravity 自己的瀏覽器：跟著工作台「操作瀏覽器」的勾選
const BROWSER_TOOL = /^(?:browser_\w+|open_browser_url|click_browser_pixel|execute_browser_javascript|list_browser_pages|read_browser_page|capture_browser_screenshot|capture_browser_console_logs)$/;
// 其餘（run_command、send_command_input、notebook_execution、run_workflow、schedule、call_mcp_tool…）一律當成「執行指令」

const LABELS = {
  run_command: '執行指令', send_command_input: '輸入指令', command_status: '查看指令狀態', view_file: '讀取檔案', list_dir: '列出資料夾',
  find_by_name: '搜尋檔名', grep_search: '搜尋內容', write_to_file: '寫入檔案', replace_file_content: '修改檔案', multi_replace_file_content: '修改檔案',
  sed_file: '修改檔案', notebook_edit: '修改筆記本', notebook_execution: '執行筆記本', search_web: '搜尋網路', read_url_content: '讀取網頁',
  open_browser_url: '瀏覽器開網頁', read_browser_page: '讀取瀏覽器頁面', invoke_subagent: '子代理', browser_subagent: '瀏覽器子代理', call_mcp_tool: 'MCP 工具',
};
const label = (name) => LABELS[name] || (BROWSER_TOOL.test(name) ? `瀏覽器：${name.replace(/^browser_/, '')}` : name);

function commandOf(args = {}) {
  return String(args.CommandLine ?? args.Command ?? args.command ?? args.Input ?? '');
}
function pathsOf(args = {}) {
  const out = [];
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && /(?:file|path)$/i.test(k) && v.trim()) out.push(v.trim());
    if (Array.isArray(v) && /(?:files|paths)$/i.test(k)) for (const x of v) if (typeof x === 'string') out.push(x);
  }
  return out;
}
function brief(name, args = {}) {
  const c = commandOf(args);
  if (c) return c.slice(0, 300);
  const p = pathsOf(args);
  if (p.length) return p.join('、').slice(0, 300);
  const u = args.Url || args.url || args.Query || args.query || args.Pattern || args.SearchPattern || args.Prompt || args.TaskName;
  if (u) return String(u).slice(0, 300);
  return '';
}
const norm = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
function inside(file, dir) {
  if (!dir) return false;
  try { const f = norm(file); const d = norm(dir); return f === d || f.startsWith(d + path.sep); } catch { return false; }
}

/**
 * 判斷一次工具呼叫。ctx：{ permission, cwd, noDelete, browser, always:{write,command} }
 * 回傳 { decision:'allow'|'deny', reason } 或 { decision:'ask', kind, detail }。
 */
function decide(call, ctx) {
  const name = String(call?.name || '');
  const args = call?.args && typeof call.args === 'object' ? call.args : {};
  const perm = ctx.permission;
  const always = perm === 'codex-review' ? {} : ctx.always || {};
  const server = args.ServerName || args.serverName || args.server_name;
  const tool = args.ToolName || args.toolName || args.tool_name;
  if (name === 'call_mcp_tool' && server === 'codex_multi_browser' && (ctx.hostBrowserTools || []).includes(tool)) return ctx.browser ? { decision: 'allow' } : { decision: 'deny', reason: '瀏覽器操作已關閉。' };
  if (perm === 'chat') return { decision: 'deny', reason: '使用者選了「僅聊天」，不能使用工具。' };
  if (BROWSER_TOOL.test(name)) return ctx.browser ? { decision: 'allow' } : { decision: 'deny', reason: '使用者沒有開啟「操作瀏覽器」，不能使用瀏覽器工具。' };
  if (perm === 'codex-review' && ['send_message', 'generate_image', 'invoke_subagent', 'define_subagent', 'manage_subagents'].includes(name)) return { decision: 'ask', kind: 'command', detail: `${label(name)}\n${JSON.stringify(args).slice(0, 1500)}` };
  if (READ_TOOLS.has(name)) return { decision: 'allow' };
  if (WRITE_TOOLS.has(name)) {
    const files = pathsOf(args);
    // Antigravity 自己的計畫／記錄檔（brain 資料夾），不是使用者的檔案
    if (files.length && files.every((f) => inside(f, AGY_DATA))) return { decision: 'allow' };
    if (perm === 'plan') return { decision: 'deny', reason: '目前是「規劃模式」：只能讀取與分析，不能寫入檔案。請改成說明你打算怎麼改。' };
    if (perm === 'bypassPermissions' || always.write) return { decision: 'allow' };
    if (perm === 'acceptEdits' && files.length && files.every((f) => inside(f, ctx.cwd))) return { decision: 'allow' };
    return { decision: 'ask', kind: 'write', detail: `${label(name)}：${files.join('\n') || name}` };
  }
  if (perm === 'plan') return { decision: 'deny', reason: '目前是「規劃模式」：不能執行指令或改變電腦狀態。請改成說明你打算怎麼做。' };
  const command = commandOf(args);
  if (ctx.noDelete) {
    const hit = deleteGuard.detect(command);
    if (hit) return { decision: 'ask', kind: 'delete', detail: `${hit}\n\n${command}` };
  }
  if (perm === 'bypassPermissions' || always.command) return { decision: 'allow' };
  return { decision: 'ask', kind: 'command', detail: command || `${label(name)}\n${JSON.stringify(args).slice(0, 1500)}` };
}

// Central hook policy: asynchronous reviewer/manual results never outlive a turn.
async function authorize(call, ctx, { review, approve, signal, active = () => true, onReview = () => {} }) {
  const stopped = () => signal?.aborted || !active();
  const cancelled = { decision: 'deny', reason: '這回合已停止。' };
  if (stopped()) return cancelled;
  const d = decide(call, ctx);
  if (d.decision !== 'ask') return d;
  let reviewReason = '';
  if (ctx.permission === 'codex-review' && d.kind !== 'delete') {
    onReview({ state: 'started', call });
    let result;
    try { result = review ? await review(call) : { decision: 'ask', reason: 'Codex 帳號未就緒，請手動確認。' }; }
    catch { result = { decision: 'ask', reason: 'Codex 審核失敗，請手動確認。' }; }
    if (stopped()) { onReview({ state: 'cancelled', call }); return cancelled; }
    if (!result || !['allow', 'deny', 'ask'].includes(result.decision) || typeof result.reason !== 'string' || !result.reason.trim()) result = { decision: 'ask', reason: 'Codex 審核結果不明，請手動確認。' };
    onReview({ state: result.decision, call, reason: result.reason });
    if (result.decision !== 'ask') return result;
    reviewReason = `Codex 審核：${result.reason}\n\n`;
  }
  const fullAction = ctx.permission === 'codex-review' ? `\n\n完整工具參數：\n${JSON.stringify(call, null, 2)}` : '';
  const answer = await approve({ kind: d.kind, detail: reviewReason + d.detail + fullAction });
  if (stopped()) return cancelled;
  if (answer.always && d.kind !== 'delete' && ctx.permission !== 'codex-review') ctx.always[d.kind] = true;
  if (answer.ok) return { decision: 'allow' };
  return { decision: 'deny', reason: d.kind === 'delete' ? '使用者設定了「禁止刪除檔案，除非經我授權」，這次刪除沒有得到授權。不要改用其他方式繞過。' : '使用者沒有同意這次操作。不要改用其他方式繞過。' };
}

/** hook 回頭詢問的本機端點（只聽 127.0.0.1，帶權杖）。handle(toolCall) 回傳 { decision, reason }。 */
async function startHookServer(handle) {
  const token = crypto.randomBytes(24).toString('hex');
  const server = http.createServer(async (req, res) => {
    const reply = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method !== 'POST' || req.url !== '/agy-tool' || req.headers.authorization !== `Bearer ${token}` || !/^127\.0\.0\.1:\d+$/.test(req.headers.host || '')) {
      res.writeHead(403); res.end(); return;
    }
    let raw = '';
    try { for await (const c of req) { raw += c; if (raw.length > 4 * 1024 * 1024) throw new Error('too large'); } } catch { res.writeHead(413); res.end(); return; }
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 空的 */ }
    try { reply(await handle(body.toolCall || {})); } catch (e) { reply({ decision: 'deny', reason: `工作台無法判斷這次工具呼叫：${e.message}` }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/agy-tool`;
  return { env: { CODEX_MULTI_AGY_HOOK_URL: url, CODEX_MULTI_AGY_HOOK_TOKEN: token }, close() { server.closeAllConnections?.(); server.close(); } };
}

/**
 * 準備中繼工作區：.agents/hooks.json＋啟動 hook 的 .cmd。
 * agy 在 Windows 用 cmd 跑 hook 指令，而且會把引號跳脫掉（實測），所以指令只能是一個不加引號的路徑；
 * CLI 從 hooks.json 所在的 .agents 目錄執行命令（真實 CLI 驗證），啟動器名稱相對該目錄。
 */
function prepareWorkspace(dir, execPath = process.execPath) {
  const agents = path.join(dir, '.agents');
  fs.mkdirSync(agents, { recursive: true });
  let command;
  if (process.platform === 'win32') {
    const launcher = path.join(agents, 'codex-multi-hook.cmd');
    command = 'codex-multi-hook.cmd';
    fs.writeFileSync(launcher, ['@echo off','chcp 65001>nul','set ELECTRON_RUN_AS_NODE=1', `"${execPath}" "${HOOK_SCRIPT}"`, ''].join('\r\n'));
  } else {
    command = path.join(agents, 'codex-multi-hook.sh');
    fs.writeFileSync(command, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${execPath}" "${HOOK_SCRIPT}"\n`, { mode: 0o755 });
  }
  const hookFile = path.join(agents, 'hooks.json');
  const existing = fs.existsSync(hookFile) ? JSON.parse(fs.readFileSync(hookFile, 'utf8')) : {};
  const hooks = { ...existing, 'codex-multi': { enabled: true, PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SEC }] }] } };
  fs.writeFileSync(hookFile, JSON.stringify(hooks, null, 2));
  return dir;
}

/** 舊版在工作區根目錄留下的 hook 若指向已不存在的執行檔（例如改名前的 Codex Multi.exe），CLI 仍會載入而讓每個工具呼叫失敗；只清除這種失效檔。 */
function removeStaleRootHook(root) {
  try {
    const agents = path.join(root, '.agents');
    const launcher = path.join(agents, 'codex-multi-hook.cmd');
    const text = fs.readFileSync(launcher, 'utf8');
    const exe = (text.match(/^"([^"]+\.exe)"/m) || [])[1];
    if (exe && !fs.existsSync(exe)) {
      const hookFile = path.join(agents, 'hooks.json');
      const hooks = JSON.parse(fs.readFileSync(hookFile, 'utf8'));
      delete hooks['codex-multi'];
      if (Object.keys(hooks).length) fs.writeFileSync(hookFile, JSON.stringify(hooks, null, 2));
      else fs.rmSync(hookFile, { force: true });
      fs.rmSync(launcher, { force: true });
    }
  } catch { /* 沒有舊檔 */ }
}

async function verifyWorkspaceHook(workspace, signal) {
  if (process.platform !== 'win32') return;
  const agents = path.join(workspace, '.agents');
  const launcher = path.join(agents, 'codex-multi-hook.cmd');
  if (signal?.aborted) throw Object.assign(new Error('已停止'), { name: 'AbortError' });
  await new Promise((resolve, reject) => {
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'codex-multi-hook.cmd'], {
      cwd: agents, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_MULTI_AGY_HOOK_URL: '', CODEX_MULTI_AGY_HOOK_TOKEN: '' },
    });
    let stdout = '', stderr = '', settled = false;
    const finish = error => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const fail = reason => new Error(`Antigravity Hook 啟動失敗：${launcher}；${reason}。請重新安裝最新版後開始新輪次。`);
    const abort = () => { killTree(child); finish(Object.assign(new Error('已停止'), { name: 'AbortError' })); };
    const timer = setTimeout(() => { killTree(child); finish(fail('啟動逾時')); }, 15000);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', c => { stdout = (stdout + c).slice(-4096); });
    child.stderr.on('data', c => { stderr = (stderr + c).slice(-4096); });
    child.on('error', e => finish(fail(e.code || '無法啟動')));
    child.stdin.on('error', e => { if (e.code !== 'EPIPE') finish(fail(e.code)); });
    child.on('close', code => {
      let result; try { result = JSON.parse(stdout); } catch { /* invalid launcher output */ }
      if (code !== 0 || result?.decision !== 'deny') return finish(fail(`退出碼 ${code}${stderr ? '；' + stderr.trim() : ''}`));
      finish();
    });
    child.stdin.end('{}');
    if (signal?.aborted) abort();
  });
}

function configureBrowserBridge(workspace, bridge) {
  const servers = bridge ? { codex_multi_browser: { serverUrl: bridge.url, headers: { Authorization: `Bearer ${bridge.token}` } } } : {};
  fs.writeFileSync(path.join(workspace, '.agents', 'mcp_config.json'), JSON.stringify({ mcpServers: servers }, null, 2));
}

/**
 * 跑一回合。回傳 { text, conversationId, denied }；onTool 收到 { index, state, name, args, output, error }。
 */
// A non-SUCCESS result still counts as complete when this run itself produced a
// finished final answer and no step of this run failed (stale resumed error).
function turnCompleted(result, { streamed, lastStep, stepFailed }) {
  if (result && result.status === 'SUCCESS') return true;
  return !stepFailed && !!String(streamed || '').trim() && !!lastStep && lastStep.type === 'agent_response' && lastStep.state === 'DONE';
}

async function run({ cli, model, prompt, workspace, project, conversationId, mode, agentName, env = {}, signal, onDelta = () => {}, onTool = () => {}, onProgress = () => {}, onConversation = () => {}, timeout = 60 * 60000 }) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('已停止'), { name: 'AbortError' }));
  await verifyWorkspaceHook(workspace, signal);
  if (signal?.aborted) throw Object.assign(new Error('已停止'), { name: 'AbortError' });
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--model', model, '--dangerously-skip-permissions'];
  if (agentName) args.push('--agent', agentName, '--disable-slash-commands');
  if (project && fs.existsSync(project)) args.push('--add-dir', project);
  if (mode === 'plan') args.push('--mode', 'plan');
  if (conversationId) args.push('--conversation', conversationId);
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, { cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let buffer = ''; let stderr = ''; let result = null; let settled = false; let streamed = ''; let convo = conversationId || '';
    // Resumed CLI conversations can report an old trajectory ERROR_MESSAGE as
    // this turn's result; track this run's own steps to tell the two apart.
    let lastStep = null; let stepFailed = false;
    const progressSeen=new Map();
    const abort = () => { killTree(child); finish(Object.assign(new Error('已停止'), { name: 'AbortError' })); };
    const timer = setTimeout(() => { killTree(child); finish(new Error('Antigravity CLI 回覆逾時')); }, timeout);
    function finish(error) {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { error.conversationId = convo; error.streamed = streamed; reject(error); return; }
      resolve({ text: streamed.trim() ? streamed : String(result.response || ''), conversationId: result.conversation_id || convo, denied: result.denied_actions || [] });
    }
    signal?.addEventListener('abort', abort, { once: true });
    function line(text) {
      let ev; try { ev = JSON.parse(text); } catch { return; }
      if (ev.event === 'init' && ev.conversation_id) { convo = ev.conversation_id; onConversation(convo); }
      if (ev.event === 'step_update' && !settled) {
        const s = ev.step_update || {};
        // Activity comes only from the existing lifecycle envelope, never raw
        // thinking/debug payloads. Unknown step kinds use a fixed generic label.
        const index=Number.isSafeInteger(s.step_index)&&s.step_index>=0?s.step_index:0;
        const activity={tool:'操作工具',agent_response:'產生回覆',thinking:'分析任務',analysis:'分析任務',planning:'規劃任務'}[s.step_type] || '處理步驟';
        const state=s.state==='DONE'?'完成':s.state==='ERROR'?'失敗':'進行中';
        const id=`step:${index}`,message=`步驟 ${index+1} · ${activity} · ${state}`;
        if (s.step_type !== 'user_input') lastStep = { type: s.step_type, state: s.state };
        if (s.state === 'ERROR' && s.step_type !== 'tool') stepFailed = true;
        if(progressSeen.get(id)!==message){progressSeen.set(id,message);if(progressSeen.size>64)progressSeen.delete(progressSeen.keys().next().value);onProgress({id,message});}
        if (s.step_type === 'agent_response' && s.text_delta) { streamed += s.text_delta; onDelta(s.text_delta); }
        if (s.step_type === 'tool') {
          const info = s.tool_info || {};
          onTool({ index: s.step_index, state: s.state, name: s.tool_name || info.name || '', args: info.parameters || {}, output: info.output, error: info.error?.message });
        }
      }
      if (ev.event === 'result') result = ev.result || {};
    }
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { buffer += chunk; let i; while ((i = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, i)); buffer = buffer.slice(i + 1); } });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', finish);
    child.stdin.on('error', (e) => { if (e.code !== 'EPIPE') finish(e); });
    child.on('close', (code) => {
      if (buffer.trim()) line(buffer);
      if (signal?.aborted) return abort();
      if (!result) return finish(new Error(String(stderr).trim().slice(-1500) || `Antigravity CLI 結束但沒有回覆（${code}）`));
      if (!turnCompleted(result, { streamed, lastStep, stepFailed })) return finish(new Error(result.error || stderr.trim().slice(-1500) || 'Antigravity CLI 回覆失敗'));
      finish();
    });
    if (signal?.aborted) { abort(); return; }
    child.stdin.end(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n');
  });
}

module.exports = { decide, authorize, startHookServer, prepareWorkspace, verifyWorkspaceHook, removeStaleRootHook, configureBrowserBridge, run, turnCompleted, label, brief, HOOK_SCRIPT, READ_TOOLS, WRITE_TOOLS };
