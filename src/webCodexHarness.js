'use strict';

// 「GPT 網頁版模仿 Codex CLI」：ChatGPT 網頁本身只會聊天，這裡在本機補上 Codex 那一層
// —— context 組裝（環境、AGENTS.md、檔案索引、Git 狀態）＋任務導向的 agent loop 指示。
// 工具實際由 webToolBridge 在本機執行，權限沿用 App 的權限設定與核准流程。

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build', 'out', '.next', '.cache', 'artifacts', 'coverage']);
const SECRET_NAMES = new Set(['.env', '.npmrc', '.pypirc', '.netrc', 'credentials', 'credentials.json', 'id_rsa', 'id_ed25519']);
function shouldSkipIndexedFile(name) {
  const lower = String(name || '').toLowerCase();
  return SKIP.has(name) || SECRET_NAMES.has(lower) || lower.startsWith('.env.') || /\.(?:pem|key|p12|pfx|keystore)$/i.test(lower);
}
const LEVEL_TEXT = {
  chat: '僅聊天（沒有檔案與指令工具，只能回答；需要動手時請告訴使用者改權限）',
  'read-only': '唯讀（可讀檔、列資料夾，不能寫檔或執行指令）',
  'workspace-write': '可寫專案（可讀寫專案內檔案；執行指令前會先請使用者同意）',
  'danger-full-access': '完全存取（可讀寫檔案、直接執行 PowerShell 指令）',
};

function readCapped(file, limit) {
  try {
    const buf = fs.readFileSync(file);
    const text = buf.toString('utf8').replace(/^\uFEFF/, '');
    return text.length > limit ? `${text.slice(0, limit)}\n…（已截斷）` : text;
  } catch { return ''; }
}

// Codex 的做法：從專案根往下（這裡只看專案資料夾與它的上層）收集 AGENTS.md
function agentsDocs(cwd, limit = 32000) {
  if (!cwd) return [];
  const dirs = [];
  let dir = path.resolve(cwd);
  for (let i = 0; i < 4; i++) {
    dirs.unshift(dir);
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const out = [];
  let budget = limit;
  for (const d of dirs) {
    for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
      const file = path.join(d, name);
      if (!fs.existsSync(file) || budget <= 0) continue;
      const text = readCapped(file, budget);
      if (!text.trim()) continue;
      budget -= text.length;
      out.push({ file, text });
      break;
    }
  }
  return out;
}

function fileIndex(cwd, max = 300) {
  if (!cwd) return { lines: [], truncated: false };
  const lines = [];
  let truncated = false;
  const walk = (dir, rel, depth) => {
    if (lines.length >= max) { truncated = true; return; }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (lines.length >= max) { truncated = true; return; }
      if (shouldSkipIndexedFile(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        lines.push(`${r}/`);
        if (depth < 3) walk(path.join(dir, e.name), r, depth + 1);
      } else lines.push(r);
    }
  };
  walk(cwd, '', 0);
  return { lines, truncated };
}

function gitStatus(cwd, timeout = 4000) {
  return new Promise((resolve) => {
    if (!cwd) return resolve('');
    execFile('git', ['status', '--short', '--branch'], { cwd, timeout, windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : String(stdout || '').split(/\r?\n/).slice(0, 40).join('\n').trim());
    });
  });
}

const RULES = [
  '你現在以編碼代理工作：使用者透過宿主程式提供的工具，讓你處理指定的專案資料夾。',
  '工作方式（agent loop）：',
  '1. 先用工具查清楚（讀檔、列資料夾、跑查詢指令），不要憑記憶猜檔案內容。',
  '2. 需要多步時先列簡短計畫，再一步一步執行；每次只呼叫一個工具，看了結果再決定下一步。',
  '3. 改檔前先讀原檔；只做需求範圍內的最小修改，沿用專案原本的風格與行尾。',
  '4. 改完要驗證（跑測試、語法檢查或重新讀檔確認）；驗證失敗就修正，不要宣稱完成。',
  '5. 遵守下面 AGENTS.md 的專案規則；它與使用者當下指示衝突時以使用者為準。',
  '6. 不要刪除檔案或執行破壞性、不可逆的指令，除非使用者明確要求；被拒絕的操作不要換個方式硬做。',
  '7. 結束時用繁體中文簡短回報：改了什麼、怎麼驗證、還有什麼沒做或有風險。',
].join('\n');

async function buildContext({ cwd, level, approval, tools = [], os = process.platform }) {
  const names = tools.map((t) => t?.function?.name).filter(Boolean);
  const parts = [RULES];
  parts.push([
    '<environment_context>',
    `專案資料夾（cwd）：${cwd || '（未選擇；檔案工具無法使用，請請使用者先選專案）'}`,
    `作業系統：${os === 'win32' ? 'Windows（指令用 PowerShell）' : os}`,
    `權限：${LEVEL_TEXT[level] || level}`,
    `核准政策：${approval === 'never' ? '不詢問（需要核准的操作不提供）' : '需要時詢問使用者'}`,
    `可用工具：${names.length ? names.join(', ') : '無'}`,
    '</environment_context>',
  ].join('\n'));
  const docs = agentsDocs(cwd);
  for (const d of docs) parts.push(`<agents_md path="${d.file}">\n${d.text.trim()}\n</agents_md>`);
  const idx = fileIndex(cwd);
  if (idx.lines.length) parts.push(`<file_index>\n${idx.lines.join('\n')}${idx.truncated ? '\n…（只列前 300 項，其餘請用 list_directory 查）' : ''}\n</file_index>`);
  const git = await gitStatus(cwd);
  if (git) parts.push(`<git_status>\n${git}\n</git_status>`);
  return parts.join('\n\n');
}

module.exports = { buildContext, agentsDocs, fileIndex, gitStatus, RULES, shouldSkipIndexedFile };
