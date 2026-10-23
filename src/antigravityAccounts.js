'use strict';
// 多個 Google 帳號同時保持登入：CLI 的登入存在 Windows 認證管理員（單一項目），
// 這裡把每個帳號的登入以 DPAPI 加密各存一份，切換時只換回該份，不執行 /logout。
// 同一時間仍只有一個帳號可供 CLI 使用。token 不進入日誌、對話或備份。
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const HELPER = path.join(__dirname, 'antigravityCred.ps1');

function powershell() { return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'); }

function defaultRun(action, file) {
  return new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER, '-Action', action];
    if (file) args.push('-File', file);
    execFile(powershell(), args, { windowsHide: true, timeout: 20000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || error.message).split(/\r?\n/).find(Boolean) || '認證管理員操作失敗'));
      try { resolve(JSON.parse(String(stdout).trim() || '{}')); } catch { reject(new Error('認證管理員回應無法解析')); }
    });
  });
}

function accountId(identity) {
  const key = String(identity.sub || identity.email || '').toLowerCase();
  return 'acc_' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

function create({ directory, run = defaultRun, verifySignedIn = async () => true } = {}) {
  if (!directory) throw new Error('directory is required');
  const registry = path.join(directory, 'accounts.json');
  const snapshot = (id) => path.join(directory, `${id}.bin`);
  let chain = Promise.resolve();
  // 所有帳號讀寫序列化，避免兩次切換同時改認證管理員。
  const serial = (work) => { const next = chain.catch(() => {}).then(work); chain = next; return next; };

  async function readRegistry() {
    try {
      const data = JSON.parse(await fs.readFile(registry, 'utf8'));
      return { accounts: Array.isArray(data.accounts) ? data.accounts.filter(a => a && /^acc_[0-9a-f]{12}$/.test(a.id)) : [] };
    } catch { return { accounts: [] }; }
  }
  async function writeRegistry(data) {
    await fs.mkdir(directory, { recursive: true });
    const tmp = `${registry}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ accounts: data.accounts }, null, 2), 'utf8');
    await fs.rename(tmp, registry);
  }
  const publicView = (a, currentId) => ({ id: a.id, email: a.email, name: a.name, current: a.id === currentId });

  async function liveInfo() {
    const info = await run('Info');
    if (!info.exists) return { exists: false };
    if (!info.email && !info.sub) return { exists: true, unknown: true };
    return { exists: true, id: accountId(info), email: info.email || '', name: info.name || '', sub: info.sub || '' };
  }

  // 把目前 CLI 的登入存成（或更新）一個帳號；回傳該帳號，沒有登入則回傳 null。
  async function captureUnlocked() {
    const live = await liveInfo();
    if (!live.exists) return null;
    if (live.unknown) throw new Error('無法辨識目前登入的 Google 帳號（登入資料沒有身分資訊），未保存。');
    await fs.mkdir(directory, { recursive: true });
    await run('Save', snapshot(live.id));
    const data = await readRegistry();
    const record = { id: live.id, email: live.email, name: live.name, addedAt: Date.now() };
    const at = data.accounts.findIndex(a => a.id === live.id);
    if (at >= 0) data.accounts[at] = { ...data.accounts[at], email: live.email, name: live.name || data.accounts[at].name };
    else data.accounts.push(record);
    await writeRegistry(data);
    return live;
  }

  async function listUnlocked() {
    let live = null;
    try { live = await captureUnlocked(); } catch { live = null; }
    const data = await readRegistry();
    return { accounts: data.accounts.map(a => publicView(a, live && live.id)), currentId: live ? live.id : '' };
  }

  async function switchUnlocked(id) {
    const data = await readRegistry();
    const target = data.accounts.find(a => a.id === id);
    if (!target) throw new Error('找不到這個帳號');
    let previous = null;
    try { previous = await captureUnlocked(); } catch { previous = null; }
    if (previous && previous.id === id) return { ok: true, id, unchanged: true };
    try { await fs.access(snapshot(id)); } catch { throw new Error('這個帳號的登入保存已遺失，請重新新增帳號。'); }
    await run('Load', snapshot(id));
    let good = false;
    try { good = await verifySignedIn(); } catch { good = false; }
    if (!good) {
      if (previous) { try { await run('Load', snapshot(previous.id)); } catch {} }
      throw new Error('切換後登入驗證失敗（授權可能已過期），已回到原帳號。請對該帳號按「重新登入」。');
    }
    return { ok: true, id };
  }

  return {
    list: () => serial(listUnlocked),
    capture: () => serial(captureUnlocked),
    switchTo: (id) => serial(() => switchUnlocked(String(id))),
    // 新增帳號前：保存目前帳號並從認證管理員移除（不執行 /logout，不撤銷 Google 端授權）。
    beginAdd: () => serial(async () => {
      const previous = await captureUnlocked();
      await run('Delete');
      return { previousId: previous ? previous.id : '' };
    }),
    // 登入視窗結束後：有新登入就登記；沒有就把原帳號放回去。
    finishAdd: ({ previousId } = {}) => serial(async () => {
      const live = await liveInfo();
      if (live.exists) { const account = await captureUnlocked(); return { ok: true, id: account.id, email: account.email }; }
      if (previousId) { await run('Load', snapshot(previousId)); return { ok: false, restored: true }; }
      return { ok: false, restored: false };
    }),
    peekLogin: () => serial(liveInfo),
    remove: (id) => serial(async () => {
      const live = await liveInfo().catch(() => ({}));
      if (live.id === id) throw new Error('目前使用中的帳號不能移除，請先切換到其他帳號。');
      const data = await readRegistry();
      if (!data.accounts.some(a => a.id === id)) throw new Error('找不到這個帳號');
      data.accounts = data.accounts.filter(a => a.id !== id);
      await writeRegistry(data);
      await fs.rm(snapshot(id), { force: true });
      return { ok: true };
    }),
    accountId,
  };
}

module.exports = { create, accountId, HELPER };
