'use strict';
// 「禁止刪除檔案，除非經我授權」。
//
// 三條路徑用同一套判斷：
//   ・API 模型（GPT API／Claude API／DeepSeek／Gemini／Grok）：工具是工作台自己執行的，
//     run_command 在跑之前直接判斷，是刪除就跳同意視窗，即使權限是「完全存取」也一樣。
//   ・Codex 與 Claude Code：指令是 CLI 自己跑的，工作台看不到。兩者都有 PreToolUse hook，
//     這裡把 deleteGuardHook.js 掛上去；hook 判斷是刪除就回頭問工作台（本機 HTTP，帶權杖），
//     工作台跳同意視窗，使用者按允許才放行，否則回 deny 並告訴模型原因。
//
// 判斷是保守的關鍵字比對：寧可多問一次，也不要漏掉。它擋得住模型用指令刪檔，
// 但不是作業系統層級的保護——模型寫一支程式、再由程式去刪檔，這裡就看不到。
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 以「指令開頭」出現才算的刪除指令（別名很短，出現在字串中間不能算）
const DELETE_COMMANDS = new Set(['rm', 'del', 'erase', 'rd', 'rmdir', 'ri', 'remove-item', 'unlink', 'shred', 'rimraf', 'sdelete', 'sdelete64', 'clear-recyclebin', 'trash', 'trash-put']);
// 在任何位置出現就算的刪除呼叫
const DELETE_PATTERNS = [
  [/\bRemove-Item\b/i, 'Remove-Item'],
  [/\bgit\s+(?:-C\s+\S+\s+)?clean\b/i, 'git clean'],
  [/\bgit\s+(?:-C\s+\S+\s+)?rm\b/i, 'git rm'],
  [/\brobocopy\b[^\n]*\s\/(?:MIR|PURGE)\b/i, 'robocopy /MIR 或 /PURGE（會刪掉目的地多出來的檔案）'],
  [/\bfind\b[^\n]*\s-delete\b/i, 'find -delete'],
  [/\bxargs\s+(?:-\S+\s+)*rm\b/i, 'xargs rm'],
  [/\[(?:System\.)?IO\.(?:File|Directory|FileInfo|DirectoryInfo)\]::Delete\s*\(/i, '.NET File/Directory.Delete'],
  [/\.Delete\s*\(\s*(?:\$true|true)?\s*\)/i, '.Delete()'],
  [/\bos\.(?:remove|unlink|rmdir|removedirs)\s*\(/, 'Python os.remove／unlink／rmdir'],
  [/\bshutil\.rmtree\s*\(/, 'Python shutil.rmtree'],
  [/\.(?:unlink|rmdir)\s*\(\s*(?:missing_ok\s*=\s*\w+)?\s*\)/, 'Python Path.unlink／rmdir'],
  [/\bfs(?:\.promises)?\.(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\s*\(/, 'Node fs.rm／unlink'],
  [/\b(?:rmSync|unlinkSync|rmdirSync)\s*\(/, 'Node rmSync／unlinkSync'],
  [/\bFileSystem\.Delete(?:File|Directory)\b/i, 'VB FileSystem.Delete'],
  [/\bformat(?:\.com)?\s+[a-z]:/i, 'format 磁碟'],
  [/\bcipher\s+\/w\b/i, 'cipher /w'],
];

/** 把一行指令拆成各段：; | & && || 換行、括號、大括號都是分段點。 */
function segments(command) {
  return String(command || '').split(/[;|&\n\r(){}`]+/).map((s) => s.trim()).filter(Boolean);
}
function firstWord(segment) {
  let s = segment.replace(/^(?:\.|&)\s+/, '');
  // cmd /c del …、powershell -Command "Remove-Item …"、sudo rm …、bash -c 'rm …'
  for (let i = 0; i < 4; i += 1) {
    const m = /^(?:"[^"]*[\\/])?(?:cmd(?:\.exe)?\s+\/[cCkK]|(?:powershell|pwsh)(?:\.exe)?\s+(?:-\w+\s+)*?(?:-c(?:ommand)?)|sudo|npx|pnpm\s+dlx|yarn\s+dlx|bunx|bash\s+-l?c|sh\s+-c|busybox|nohup|time)\s+["']?/i.exec(s);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  const word = (/^["']?([^\s"']+)/.exec(s) || [])[1] || '';
  return path.basename(word.replace(/\\/g, '/')).replace(/\.(exe|cmd|bat|ps1)$/i, '');
}

/** 回傳「為什麼算刪除」的說明；不是刪除就回 null。 */
function detect(command) {
  const text = String(command || '');
  if (!text.trim()) return null;
  for (const seg of segments(text)) {
    const w = firstWord(seg);
    if (DELETE_COMMANDS.has(w.toLowerCase())) return `刪除指令「${w}」`;
  }
  for (const [re, label] of DELETE_PATTERNS) if (re.test(text)) return label;
  return null;
}

/** 判斷一次 CLI 工具呼叫（Codex／Claude Code 的 hook 輸入）。 */
function detectToolCall(toolName, toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const name = String(toolName || '');
  if (/^(?:apply_patch|Edit|Write)$/i.test(name) || /\*\*\* Delete File:/.test(String(input.command || input.patch || input.input || ''))) {
    const patch = String(input.command || input.patch || input.input || '');
    const files = [...patch.matchAll(/^\*\*\* Delete File:\s*(.+)$/gm)].map((m) => m[1].trim());
    if (files.length) return { reason: `用 apply_patch 刪除檔案：${files.slice(0, 5).join('、')}${files.length > 5 ? ` 等 ${files.length} 個` : ''}`, detail: files.join('\n') };
    if (/^(?:apply_patch|Edit|Write)$/i.test(name)) return null;
  }
  const command = Array.isArray(input.command) ? input.command.join(' ') : String(input.command ?? input.cmd ?? input.script ?? '');
  const reason = detect(command);
  return reason ? { reason, detail: command } : null;
}

/**
 * 給 CLI 的 hook 用的本機同意端點。ask({reason, detail, tool}) 回傳 true／false。
 * 回傳 { url, token, env, close }；env 要交給 CLI 行程，hook 會繼承。
 */
async function startGuard({ ask }) {
  const token = crypto.randomBytes(24).toString('hex');
  const server = http.createServer(async (req, res) => {
    const reply = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method !== 'POST' || req.url !== '/delete-approval' || req.headers.authorization !== `Bearer ${token}` || !/^127\.0\.0\.1:\d+$/.test(req.headers.host || '')) {
      res.writeHead(403); res.end(); return;
    }
    let raw = '';
    try { for await (const c of req) { raw += c; if (raw.length > 1024 * 1024) throw new Error('too large'); } } catch { res.writeHead(413); res.end(); return; }
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 空的 */ }
    let allowed = false;
    try { allowed = !!(await ask({ reason: String(body.reason || ''), detail: String(body.detail || ''), tool: String(body.tool || '') })); } catch { allowed = false; }
    reply({ allow: allowed });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/delete-approval`;
  return {
    url, token,
    env: { CODEX_MULTI_DELETE_GUARD_URL: url, CODEX_MULTI_DELETE_GUARD_TOKEN: token },
    close() { server.closeAllConnections?.(); server.close(); },
  };
}

// 同意視窗最多等 120 秒；hook 自己的逾時要比它長，不然 CLI 會先把 hook 砍掉
const HOOK_TIMEOUT_SEC = 150;
const HOOK_SCRIPT = path.join(__dirname, 'deleteGuardHook.js');

/** hook 的啟動指令：用工作台自己的執行檔以 Node 模式跑，不依賴使用者有沒有裝 Node。 */
function hookCommand(execPath = process.execPath) {
  return `"${execPath}" "${HOOK_SCRIPT}"`;
}
/** 以 Node 模式跑 Electron 需要這個變數；一般 Node 會忽略它。 */
const HOOK_ENV = { ELECTRON_RUN_AS_NODE: '1' };

/** Claude Code：寫一份只含 hook 的設定檔，用 --settings 帶入（不動使用者自己的設定）。 */
function claudeSettings(dir, execPath) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'delete-guard-settings.json');
  const hooks = { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: hookCommand(execPath), timeout: HOOK_TIMEOUT_SEC }] }] };
  fs.writeFileSync(file, JSON.stringify({ hooks }, null, 2));
  return file;
}

/**
 * Codex 在 Windows 用 PowerShell 5.1 執行 hook（實測），`"路徑" "路徑"` 在 PowerShell 只是字串、
 * 不會執行，hook 等於沒裝——而 Codex 對 hook 是「失敗就放行」。所以要用呼叫運算子 &。
 * stdin 讓子程序直接繼承（實測）：改用 $input 管線會經過 PowerShell 的字碼頁轉換，中文檔名會變亂碼。
 */
function codexHookCommand(execPath = process.execPath) {
  if (process.platform !== 'win32') return hookCommand(execPath);
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  return `& ${q(execPath)} ${q(HOOK_SCRIPT)}`;
}

/** Codex：用 -c 帶入行內 hooks（不寫進使用者的 config.toml），並略過 hook 信任審查。 */
function codexArgs(execPath, command = codexHookCommand(execPath)) {
  const toml = `[{matcher="^(Bash|apply_patch)$",hooks=[{type="command",command=${JSON.stringify(command)},timeout=${HOOK_TIMEOUT_SEC},statusMessage="檢查是否刪除檔案"}]}]`;
  return ['-c', `hooks.PreToolUse=${toml}`, '--dangerously-bypass-hook-trust'];
}

module.exports = { detect, detectToolCall, startGuard, hookCommand, codexHookCommand, claudeSettings, codexArgs, HOOK_ENV, HOOK_TIMEOUT_SEC, HOOK_SCRIPT };
