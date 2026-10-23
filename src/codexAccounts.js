'use strict';
// Codex 多帳號：每個帳號的 auth.json 另存一份（加密），切換時換掉 CODEX_HOME 裡的 auth.json。
// 新帳號用暫時的 CODEX_HOME 執行 `codex login`，不會動到目前登入的帳號。
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const INDEX = 'accounts.json';

function homeDir(codexHome) {
  return (codexHome && codexHome.trim()) || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function decodeJwt(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
}

// auth.json → 帳號身分（不含任何 token）
function identify(auth) {
  if (!auth || typeof auth !== 'object') return null;
  const tokens = auth.tokens || null;
  if (tokens && tokens.id_token) {
    const p = decodeJwt(tokens.id_token) || {};
    const a = p['https://api.openai.com/auth'] || {};
    const accountId = tokens.account_id || a.chatgpt_account_id || '';
    const userId = a.chatgpt_user_id || a.user_id || p.sub || '';
    if (!userId && !accountId) return null;
    const org = (a.organizations || []).find((o) => o && o.id === accountId) || null;
    return {
      id: 'cx_' + crypto.createHash('sha256').update(`${userId}|${accountId}`).digest('hex').slice(0, 16),
      kind: 'chatgpt',
      email: p.email || '',
      plan: a.chatgpt_plan_type || '',
      workspace: (org && org.title) || '',
    };
  }
  const key = auth.OPENAI_API_KEY;
  if (typeof key === 'string' && key.length > 8) {
    return { id: 'key_' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 16), kind: 'apikey', email: '', plan: 'API 金鑰', workspace: '', hint: `…${key.slice(-4)}` };
  }
  return null;
}

function labelOf(acc) {
  if (!acc) return '';
  if (acc.name) return acc.name;
  if (acc.kind === 'apikey') return `API 金鑰 ${acc.hint || ''}`.trim();
  return acc.email || '未知帳號';
}

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; }
}

async function writeAtomic(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
}

function createStore({ dir, encrypt, decrypt }) {
  let operationTail = Promise.resolve();
  const exclusive = (fn) => { const next = operationTail.then(fn); operationTail = next.catch(() => {}); return next; };
  const indexFile = () => path.join(dir, INDEX);
  const secretFile = (id) => path.join(dir, `${String(id).replace(/[^a-zA-Z0-9_]/g, '')}.auth`);
  const runtimes = require('./codexRuntimeHomes').create({ dir, identify, readJson, readSecret, upsert: upsertNow, writeAtomic });

  async function readIndex() {
    const data = await readJson(indexFile());
    return Array.isArray(data && data.accounts) ? data.accounts : [];
  }
  async function writeIndex(accounts) { await writeAtomic(indexFile(), JSON.stringify({ accounts }, null, 1)); }

  async function readSecret(id) {
    try {
      const plain = decrypt((await fsp.readFile(secretFile(id), 'utf8')).trim());
      return plain ? JSON.parse(plain) : null;
    } catch { return null; }
  }

  // 儲存（或更新）一個帳號的 auth.json；回傳帳號資料
  async function upsertNow(auth, extra = {}) {
    const who = identify(auth);
    if (!who) throw new Error('這份 Codex 登入資料看不出是哪個帳號');
    const accounts = await readIndex();
    const now = new Date().toISOString();
    let acc = accounts.find((a) => a.id === who.id);
    if (acc) Object.assign(acc, who, { updatedAt: now }, extra);
    else { acc = { ...who, addedAt: now, updatedAt: now, ...extra }; accounts.push(acc); }
    await writeAtomic(secretFile(who.id), encrypt(JSON.stringify(auth)));
    await writeIndex(accounts);
    return acc;
  }

  // 列出帳號；目前 CODEX_HOME 的登入如果還沒存過，自動存起來（切走時才不會遺失）
  async function list(codexHome) {
    await runtimes.sync();
    const auth = await readJson(path.join(homeDir(codexHome), 'auth.json'));
    const who = identify(auth);
    let accounts = await readIndex();
    if (who) {
      await upsertNow(auth);
      accounts = await readIndex();
    }
    return {
      home: homeDir(codexHome),
      activeId: who ? who.id : null,
      accounts: accounts.map((a) => ({ ...a, label: labelOf(a), active: !!who && a.id === who.id })),
    };
  }

  async function switchTo(id, codexHome, { beforeActivate } = {}) {
    await runtimes.sync();
    const target = await readSecret(id);
    if (!target) throw new Error('找不到這個帳號的登入資料，請重新登入一次');
    const home = homeDir(codexHome);
    const file = path.join(home, 'auth.json');
    let current = await readJson(file);
    let who = identify(current);
    if (who && who.id === id) return { ok: true, unchanged: true };
    if (beforeActivate && !(await beforeActivate())) return { ok: false, cancelled: true };
    current = await readJson(file); who = identify(current);
    if (who?.id === id) return { ok: true, unchanged: true };
    // 先把目前帳號的最新 token 存回去（Codex 會自動更新 token，舊副本可能已失效）
    if (who) await upsertNow(current);
    await fsp.mkdir(home, { recursive: true });
    if (current) await fsp.copyFile(file, path.join(home, 'auth.json.multi-backup')).catch(() => {});
    await writeAtomic(file, JSON.stringify(target, null, 2));
    const accounts = await readIndex();
    const acc = accounts.find((a) => a.id === id);
    if (acc) { acc.lastUsedAt = new Date().toISOString(); await writeIndex(accounts); }
    return { ok: true, account: acc ? { ...acc, label: labelOf(acc) } : null };
  }

  async function rename(id, name) {
    const accounts = await readIndex();
    const acc = accounts.find((a) => a.id === id);
    if (!acc) throw new Error('找不到這個帳號');
    acc.name = String(name || '').trim().slice(0, 60) || undefined;
    await writeIndex(accounts);
    return { ok: true };
  }

  // 只刪除本 App 存的副本；目前登入中的帳號不會被登出
  async function remove(id) {
    await runtimes.forget(id);
    await writeIndex((await readIndex()).filter((a) => a.id !== id));
    await fsp.rm(secretFile(id), { force: true });
    return { ok: true };
  }

  // 用暫時的 CODEX_HOME 執行 `codex login`，成功後存成新帳號
  let pending = null;
  function login({ spawnCli, codexPath, killTree, onUrl, codexHome, switchAfter = false, beforeActivate, deviceAuth = false, timeoutMs = 10 * 60 * 1000 }) {
    if (pending) return pending.promise;
    const tmpHome = path.join(dir, `login-${crypto.randomBytes(4).toString('hex')}`);
    const state = { child: null, cancelled: false };
    const promise = (async () => {
      await fsp.mkdir(tmpHome, { recursive: true });
      try {
        const out = await new Promise((resolve) => {
          let log = '';
          const seen = new Set();
          let child;
          try {
            child = spawnCli(codexPath, ['login', '-c', 'cli_auth_credentials_store="file"', ...(deviceAuth ? ['--device-auth'] : [])], { env: { ...process.env, CODEX_HOME: tmpHome }, cwd: tmpHome });
          } catch (e) { resolve({ code: -1, log: String(e.message) }); return; }
          state.child = child;
          const onData = (d) => {
            log = (log + d).slice(-8000);
            for (const m of String(d).matchAll(/https?:\/\/[^\s"'<>]+/g)) {
              if (!seen.has(m[0])) { seen.add(m[0]); onUrl && onUrl(m[0], log); }
            }
            if (deviceAuth && onUrl) onUrl(null, log);
          };
          child.stdout.on('data', onData);
          child.stderr.on('data', onData);
          child.on('error', (e) => resolve({ code: -1, log: log + String(e.message) }));
          child.on('close', (code) => resolve({ code, log }));
          const timer = setTimeout(() => { state.cancelled = true; killTree(child); }, timeoutMs);
          child.on('close', () => clearTimeout(timer));
        });
        if (state.cancelled) return { ok: false, cancelled: true, message: '已取消登入' };
        const auth = await readJson(path.join(tmpHome, 'auth.json'));
        if (!auth || !identify(auth)) {
          const tail = out.log.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ');
          return { ok: false, message: `沒有完成登入${tail ? `：${tail.slice(0, 200)}` : ''}` };
        }
        return await exclusive(async () => {
          const home = codexHome !== undefined ? homeDir(codexHome) : null;
          const file = home && path.join(home, 'auth.json');
          let current = file ? await readJson(file) : null;
          let same = identify(current)?.id === identify(auth).id;
          const activate = !!home && (switchAfter || same);
          if (activate && beforeActivate && !(await beforeActivate())) return { ok: false, cancelled: true };
          if (activate) {
            current = await readJson(file);
            same = identify(current)?.id === identify(auth).id;
            // Same-account re-login must replace active credentials, never save the old copy over the fresh login.
            if (current && !same && identify(current)) await upsertNow(current);
            await fsp.mkdir(home, { recursive: true });
            if (current) await fsp.copyFile(file, path.join(home, 'auth.json.multi-backup')).catch(() => {});
            await writeAtomic(file, JSON.stringify(auth, null, 2));
          }
          const acc = await upsertNow(auth);
          return { ok: true, renewed: activate && same, switched: activate && !same, account: { ...acc, label: labelOf(acc) } };
        });
      } finally {
        await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
      }
    })().finally(() => { pending = null; });
    pending = { promise, cancel: () => { state.cancelled = true; if (state.child) killTree(state.child); } };
    return promise;
  }
  function cancelLogin() { if (pending) { pending.cancel(); return { ok: true }; } return { ok: false }; }

  const captureRunHome = (home) => exclusive(async () => ({ ...await runtimes.capture(homeDir(home)), release: () => exclusive(() => runtimes.sync()) }));
  return { captureRunHome, list: (...a) => exclusive(() => list(...a)), switchTo: (...a) => exclusive(() => switchTo(...a)), upsert: (...a) => exclusive(() => upsertNow(...a)), rename: (...a) => exclusive(() => rename(...a)), remove: (...a) => exclusive(() => remove(...a)), login, cancelLogin, readSecret };
}

module.exports = { createStore, identify, labelOf, homeDir };
