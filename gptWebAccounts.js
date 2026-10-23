'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { replace } = require('./atomicRename');

// This index stores labels and IDs only. Browser cookies stay in separate profiles.
function create({ directory, login: loginProfile, closeProfile = async () => {}, isBusy = () => false }) {
  if (!directory || typeof loginProfile !== 'function') throw new Error('GPT web accounts require directory and login');
  const base = path.resolve(directory);
  const root = path.join(base, 'gpt-web-accounts');
  const profiles = path.join(root, 'profiles');
  const manifest = path.join(root, 'accounts.json');
  const validId = id => id === 'default' || /^gpt_[a-f0-9]{32}$/.test(id);
  const profileOf = id => {
    if (typeof id !== 'string' || !validId(id)) throw new Error('Invalid GPT web account ID');
    return id === 'default' ? path.join(base, 'chatgpt-web-profile') : path.join(profiles, id);
  };
  const normalizeName = name => String(name || '').trim().slice(0, 80) || 'ChatGPT';
  let tail = Promise.resolve();
  const exclusive = fn => { const next = tail.then(fn); tail = next.catch(() => {}); return next; };
  const loggingIn = new Set();

  async function stat(file) {
    try { return await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  // Never follow a profile or intermediate directory junction/symlink for deletion.
  async function checkPath(target, { file = false } = {}) {
    const relative = path.relative(base, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe GPT web profile path');
    const parts = [base];
    for (const part of relative.split(path.sep).filter(Boolean)) parts.push(path.join(parts.at(-1), part));
    for (let i = 0; i < parts.length; i++) {
      const info = await stat(parts[i]);
      if (!info) continue;
      if (info.isSymbolicLink() || (!info.isDirectory() && !(file && i === parts.length - 1 && info.isFile()))) {
        throw new Error('Unsafe GPT web profile path: symlink or unexpected file');
      }
    }
  }
  async function marked(id) {
    const profileDir = profileOf(id);
    await checkPath(profileDir);
    const marker = await stat(path.join(profileDir, 'chatgpt-login.json'));
    return !!marker && marker.isFile() && !marker.isSymbolicLink();
  }
  async function save(state) {
    await checkPath(manifest, { file: true });
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const temporary = path.join(root, `accounts.${crypto.randomBytes(16).toString('hex')}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 });
      await replace(temporary, manifest);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  async function read() {
    await checkPath(manifest, { file: true });
    let state;
    try { state = JSON.parse(await fs.readFile(manifest, 'utf8')); }
    catch (error) {
      // A broken index must not silently reimport deleted accounts or overwrite data.
      if (error.code !== 'ENOENT') throw new Error(`Cannot read GPT web accounts: ${error.message}`);
      state = { version: 1, legacyImported: true, activeId: null, accounts: [] };
      if (await marked('default')) {
        state.accounts.push({ id: 'default', name: 'ChatGPT' });
        state.activeId = 'default';
      }
      await save(state);
    }
    if (state?.version !== 1 || state.legacyImported !== true || !Array.isArray(state.accounts)) throw new Error('Invalid GPT web accounts manifest');
    const seen = new Set();
    for (const account of state.accounts) {
      if (!account || typeof account.id !== 'string' || !validId(account.id) || seen.has(account.id) || typeof account.name !== 'string') throw new Error('Invalid GPT web account in manifest');
      seen.add(account.id);
    }
    if (state.activeId !== null && !seen.has(state.activeId)) throw new Error('Invalid active GPT web account');
    // Discard arbitrary properties, including any supplied profile paths.
    return { version: 1, legacyImported: true, activeId: state.activeId, accounts: state.accounts.map(a => ({ id: a.id, name: a.name })) };
  }
  function find(state, id) {
    const account = state.accounts.find(a => a.id === id);
    if (!account) throw new Error('找不到 ChatGPT 帳號，請在連線選單登入或重新選擇帳號。');
    return account;
  }
  async function summary(state) {
    return { activeId: state.activeId, accounts: await Promise.all(state.accounts.map(async account => ({ ...account, loggedIn: await marked(account.id) }))) };
  }
  async function ensureIdle(account) {
    if (loggingIn.has(account.id) || await isBusy(profileOf(account.id), account.id)) throw new Error('這個 ChatGPT 帳號正在登入、回覆或排隊；請等結束後再移除或重新登入。');
  }
  const list = () => exclusive(async () => summary(await read()));
  const active = id => exclusive(async () => {
    const state = await read();
    const selected = id === undefined ? state.activeId : id;
    if (selected === null) return null;
    const account = find(state, selected);
    await checkPath(profileOf(account.id));
    return { ...account, profileDir: profileOf(account.id) };
  });
  const switchTo = id => exclusive(async () => {
    const state = await read();
    const account = find(state, id);
    await checkPath(profileOf(account.id));
    state.activeId = account.id;
    await save(state);
    return { ok: true, ...(await summary(state)) };
  });
  const rename = ({ id, name }) => exclusive(async () => {
    const state = await read();
    find(state, id).name = normalizeName(name);
    await save(state);
    return { ok: true, ...(await summary(state)) };
  });
  const remove = id => exclusive(async () => {
    const state = await read();
    const account = find(state, id);
    await ensureIdle(account);
    const profileDir = profileOf(id);
    await checkPath(profileDir);
    await closeProfile(profileDir, id);
    await checkPath(profileDir);
    await fs.rm(profileDir, { recursive: true, force: true });
    state.accounts = state.accounts.filter(a => a.id !== id);
    if (state.activeId === id) state.activeId = state.accounts[0]?.id || null;
    await save(state);
    return { ok: true, ...(await summary(state)) };
  });
  async function login(options = {}) {
    const account = await exclusive(async () => {
      const state = await read();
      const existing = options.id !== undefined && options.id !== null;
      const account = existing ? { ...find(state, options.id), existing } : { id: `gpt_${crypto.randomBytes(16).toString('hex')}`, name: normalizeName(options.name), existing };
      await ensureIdle(account);
      await checkPath(profileOf(account.id));
      if (!existing) await fs.mkdir(profileOf(account.id), { recursive: true, mode: 0o700 });
      loggingIn.add(account.id);
      return account;
    });
    const profileDir = profileOf(account.id);
    let committed = false;
    try {
      const result = await loginProfile({ ...options, accountId: account.id, profileDir, importExistingLogin: false });
      if (!result?.ok) return result || { ok: false };
      return await exclusive(async () => {
        const state = await read();
        if (account.existing) {
          const current = find(state, account.id);
          if (options.name !== undefined) current.name = normalizeName(options.name);
        } else {
          state.accounts.push({ id: account.id, name: account.name });
          state.activeId = account.id;
        }
        await save(state);
        committed = true;
        return { ok: true, id: account.id, ...(await summary(state)) };
      });
    } finally {
      if (!account.existing && !committed) {
        try {
          await checkPath(profileDir);
          await closeProfile(profileDir, account.id);
          await checkPath(profileDir);
          await fs.rm(profileDir, { recursive: true, force: true });
        } finally { loggingIn.delete(account.id); }
      } else loggingIn.delete(account.id);
    }
  }
  return { list, active, login, switch: switchTo, remove, rename };
}

module.exports = { create };
