// 沿用 Claude 桌面版的登入狀態。
//
// 為什麼原本沿用不了：
//   Claude 桌面版把登入的 OAuth token 存在 Chromium 的加密快取裡
//   （<桌面版資料夾>\config.json 的 oauth:tokenCacheV2），
//   解密金鑰放在同資料夾的 Local State（os_crypt.encrypted_key），
//   而且那支金鑰被 Windows DPAPI（CurrentUser）保護。
//   獨立安裝的 Claude Code CLI 只會讀 <設定資料夾>/.credentials.json，
//   完全不知道桌面版的加密快取，所以你明明在桌面版登入過，
//   CLI 還是回報「Not logged in · Please run /login」。
//
// 這裡做的事（全部在本機、不連外網）：
//   1. 用 DPAPI 解開 Local State 裡的 AES-256-GCM 金鑰
//   2. 用它解密 config.json 的 oauth:tokenCacheV2，取出可用的 access / refresh token
//   3. 寫成 CLI 讀得懂的 .credentials.json 到一個獨立的設定資料夾
//   4. 之後啟動 CLI 時指定 CLAUDE_CONFIG_DIR 指向該資料夾，等同沿用桌面版登入
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const TOKEN_KEYS = ['oauth:tokenCacheV2', 'oauth:tokenCache'];
const SCOPES = ['user:inference', 'user:file_upload', 'user:profile', 'user:sessions:claude_code'];

function desktopRoots() {
  const roots = [];
  const local = process.env.LOCALAPPDATA;
  if (local) {
    const packages = path.join(local, 'Packages');
    try {
      for (const name of fs.readdirSync(packages)) {
        if (/^Claude_/i.test(name)) roots.push(path.join(packages, name, 'LocalCache', 'Roaming', 'Claude'));
      }
    } catch { /* 沒有 Packages 資料夾 */ }
  }
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'Claude'));
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'Claude'));
  return roots;
}

function findDesktopRoot() {
  for (const root of desktopRoots()) {
    try {
      if (fs.existsSync(path.join(root, 'config.json')) && fs.existsSync(path.join(root, 'Local State'))) return root;
    } catch { /* 略過讀不到的 */ }
  }
  return null;
}

// Windows DPAPI（CurrentUser）解開 Local State 的 os_crypt 金鑰
function dpapiUnprotect(blob) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') { reject(new Error('桌面版登入沿用目前只支援 Windows')); return; }
    const b64 = blob.toString('base64');
    const script = "Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String('" + b64 +
      "');$k=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');[Console]::Out.Write([Convert]::ToBase64String($k))";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) { reject(new Error(`無法用 Windows DPAPI 解開桌面版金鑰：${String(stderr || err.message).trim()}`)); return; }
        const key = Buffer.from(String(stdout).trim(), 'base64');
        if (key.length !== 32) { reject(new Error('桌面版金鑰長度異常，無法沿用')); return; }
        resolve(key);
      });
  });
}

function aesKeyFromLocalState(root) {
  const ls = JSON.parse(fs.readFileSync(path.join(root, 'Local State'), 'utf8'));
  const enc = ls && ls.os_crypt && ls.os_crypt.encrypted_key;
  if (!enc) throw new Error('桌面版 Local State 沒有 os_crypt.encrypted_key');
  const raw = Buffer.from(enc, 'base64');
  const prefix = raw.slice(0, 5).toString('ascii');
  if (prefix !== 'DPAPI') throw new Error(`桌面版金鑰不是 DPAPI 格式（${prefix}），這個版本的桌面版還無法沿用`);
  return dpapiUnprotect(raw.slice(5));
}

function decryptTokenCache(key, root) {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  let lastErr = null;
  for (const field of TOKEN_KEYS) {
    const b64 = cfg[field];
    if (typeof b64 !== 'string' || !b64) continue;
    try {
      const blob = Buffer.from(b64, 'base64');
      const nonce = blob.slice(3, 15);
      const tag = blob.slice(blob.length - 16);
      const ct = blob.slice(15, blob.length - 16);
      const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
      d.setAuthTag(tag);
      const text = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`桌面版 token 快取無法解密${lastErr ? `：${lastErr.message}` : ''}`);
}

function pickBest(cache) {
  const now = Date.now();
  const entries = [];
  for (const [name, v] of Object.entries(cache || {})) {
    if (!v || typeof v !== 'object' || !v.token || !v.refreshToken) continue;
    entries.push({
      name,
      accessToken: String(v.token),
      refreshToken: String(v.refreshToken),
      expiresAt: Number(v.expiresAt) || 0,
      subscriptionType: v.subscriptionType || null,
      rateLimitTier: v.rateLimitTier || null,
      expired: (Number(v.expiresAt) || 0) < now,
    });
  }
  if (!entries.length) return null;
  // 優先沒過期的，其次選到期時間最晚的（通常是主帳號最新的一組）
  entries.sort((a, b) => (a.expired === b.expired ? b.expiresAt - a.expiresAt : (a.expired ? 1 : -1)));
  const best = entries[0];
  // 多帳號時挑 token 內含推論權限的；沒標註就沿用排序結果
  const withInference = entries.find((e) => !e.expired && /user:inference/.test(e.name));
  return withInference || best;
}

async function readDesktopToken() {
  const root = findDesktopRoot();
  if (!root) throw new Error('找不到 Claude 桌面版的設定資料夾（可能還沒安裝或還沒登入過）');
  const key = await aesKeyFromLocalState(root);
  const cache = decryptTokenCache(key, root);
  const best = pickBest(cache);
  if (!best) throw new Error('桌面版裡找不到可用的登入憑證，請先在 Claude 桌面版登入');
  return { root, token: best };
}

function credentialsOf(token) {
  return {
    claudeAiOauth: {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      scopes: SCOPES,
      subscriptionType: token.subscriptionType,
      rateLimitTier: token.rateLimitTier,
    },
  };
}

function readExistingCredentials(configDir) {
  try { return JSON.parse(fs.readFileSync(path.join(configDir, '.credentials.json'), 'utf8')); } catch { return null; }
}

function writeCredentials(configDir, creds) {
  fs.mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, '.credentials.json');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(creds, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

/**
 * 把桌面版登入匯入到指定的設定資料夾，讓獨立 CLI 能沿用。
 * 若該資料夾已有更新（或同樣新）且未過期的憑證，就不覆蓋（CLI 自己 refresh 過的更新）。
 */
async function importDesktopLogin(configDir) {
  const { root, token } = await readDesktopToken();
  const existing = readExistingCredentials(configDir);
  const mine = existing && existing.claudeAiOauth;
  const now = Date.now();
  if (mine && mine.accessToken && mine.refreshToken && (Number(mine.expiresAt) || 0) > now &&
      (Number(mine.expiresAt) || 0) >= token.expiresAt) {
    return {
      ok: true, reused: true, configDir, desktopRoot: root,
      subscriptionType: mine.subscriptionType || token.subscriptionType,
      expiresAt: Number(mine.expiresAt) || 0,
    };
  }
  writeCredentials(configDir, credentialsOf(token));
  return {
    ok: true, reused: false, configDir, desktopRoot: root,
    subscriptionType: token.subscriptionType,
    expiresAt: token.expiresAt,
  };
}

/** 只做檢查，不寫任何檔案。 */
async function status() {
  try {
    const { root, token } = await readDesktopToken();
    return {
      ok: true, desktopRoot: root,
      subscriptionType: token.subscriptionType,
      rateLimitTier: token.rateLimitTier,
      expiresAt: token.expiresAt,
      expired: token.expired,
    };
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
}

module.exports = { findDesktopRoot, readDesktopToken, importDesktopLogin, status, SCOPES };
