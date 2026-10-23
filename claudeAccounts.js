'use strict';

// Each successful authorization owns a separate CLI profile. Changing the selected
// account never rewrites the profile used by a running conversation.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
function defaultProfile(userDir, home = require('os').homedir()) {
  const managed = path.join(userDir, 'claude-desktop-profile');
  const global = path.join(home, '.claude');
  return !fs.existsSync(path.join(managed, '.credentials.json')) && fs.existsSync(path.join(global, '.credentials.json')) ? global : managed;
}

function profileKey(dir) {
  const resolved = path.resolve(String(dir || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function safeMetadata(dir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8')).oauthAccount;
    if (!value || typeof value !== 'object') return {};
    return {
      ...(typeof value.emailAddress === 'string' ? { email: value.emailAddress.slice(0, 300) } : {}),
      ...(typeof value.displayName === 'string' ? { displayName: value.displayName.slice(0, 100) } : {}),
    };
  } catch { return {}; }
}

function createStore({ getSettings, saveSettings, userDir, cli = require('./claudeCode'), runningProfiles = () => [], onChange = () => {} }) {
  if (typeof getSettings !== 'function' || typeof saveSettings !== 'function' || typeof userDir !== 'string') throw new Error('Claude 帳號儲存設定無效');
  const fallbackProfile = defaultProfile(userDir);
  const cache = new Map();
  let selectionVersion = 0;
  let pending = null;
  const config = () => getSettings().providers?.claude || {};
  const currentProfile = () => config().configDir?.trim() || fallbackProfile;
  const customPath = () => config().claudePath || '';

  function accounts() {
    const seen = new Set();
    const saved = (Array.isArray(getSettings().claudeAccounts) ? getSettings().claudeAccounts : []).filter(a => a && typeof a.id === 'string' && typeof a.configDir === 'string' && a.configDir.trim()).map(a => {
      const out = { id: a.id, configDir: a.configDir, label: String(a.label || 'Claude 帳號').slice(0, 100) };
      for (const key of ['name', 'email', 'plan', 'source']) if (typeof a[key] === 'string') out[key] = a[key].slice(0, 300);
      if (Array.isArray(a.previousConfigDirs)) out.previousConfigDirs = [...new Set(a.previousConfigDirs.filter(dir => typeof dir === 'string' && dir.trim()))];
      return out;
    }).filter(a => { if (seen.has(a.id)) return false; seen.add(a.id); return true; });
    const current = currentProfile();
    if (!saved.some(a => profileKey(a.configDir) === profileKey(current))) {
      const id = seen.has('current') ? 'profile_' + crypto.createHash('sha256').update(profileKey(current)).digest('hex').slice(0, 16) : 'current';
      saved.push({ id, label: '目前的 Claude 帳號', configDir: current });
    }
    return saved;
  }

  function invalidate({ selectionChanged = false } = {}) {
    cache.clear();
    if (selectionChanged) selectionVersion++;
  }

  function persist(nextAccounts, nextProfile) {
    const settings = getSettings();
    const previousAccounts = settings.claudeAccounts;
    const previousProfile = settings.providers.claude.configDir;
    const previousVia = settings.providers.claude.via;
    settings.claudeAccounts = nextAccounts;
    if (nextProfile !== undefined) {
      settings.providers.claude.configDir = nextProfile;
      settings.providers.claude.via = 'claudecode';
    }
    try { saveSettings(); }
    catch (error) {
      settings.claudeAccounts = previousAccounts;
      settings.providers.claude.configDir = previousProfile;
      settings.providers.claude.via = previousVia;
      throw error;
    }
    if (nextProfile !== undefined) selectionVersion++;
    invalidate();
    // Cache notifications cannot turn a committed authorization into a failed
    // attempt and make cleanup delete a profile that was just registered.
    try { onChange(); } catch {}
  }

  async function status(dir, refresh) {
    const exe = customPath();
    const key = exe + '\0' + profileKey(dir);
    const entry = cache.get(key);
    if (!refresh && entry && (entry.promise || Date.now() - entry.at < 30000)) return entry.promise || entry.value;
    const next = { at: 0, promise: null };
    next.promise = Promise.resolve().then(() => cli.authStatus(exe, dir)).catch(() => ({ ok: false, loggedIn: null, message: '無法讀取 Claude 登入狀態，請重新讀取或檢查 CLI 設定。' })).then(value => {
      // Do not reuse a failed query, or let a late query refill an invalidated cache.
      if (cache.get(key) === next) {
        if (value.ok) { next.value = value; next.at = Date.now(); next.promise = null; }
        else cache.delete(key);
      }
      return value;
    });
    cache.set(key, next);
    return next.promise;
  }

  async function list({ refresh = false } = {}) {
    const snapshot = accounts();
    const states = await Promise.all(snapshot.map(a => status(a.configDir, refresh)));
    const byProfile = new Map(snapshot.map((a, i) => [profileKey(a.configDir), states[i]]));
    // Reread records after async CLI queries: removed/renamed/re-authorized rows
    // must not reappear with an old name or an old profile's authentication.
    const current = profileKey(currentProfile());
    return { configDir: currentProfile(), accounts: accounts().map(a => {
      const info = byProfile.get(profileKey(a.configDir)) || { ok: false, message: '帳號設定已更新；請重新讀取登入狀態。' };
      const local = safeMetadata(a.configDir);
      const email = typeof info.email === 'string' ? info.email : (a.email || local.email || '');
      const plan = typeof info.subscriptionType === 'string' ? info.subscriptionType : (a.plan || '');
      const label = a.name || (a.name === '' ? email || 'Claude 帳號' : a.label) || email || 'Claude 帳號';
      return { ...a, label, email, plan, active: profileKey(a.configDir) === current,
        loginStatus: info.ok ? info.loggedIn === true ? 'loggedIn' : 'loggedOut' : 'unknown',
        message: typeof info.message === 'string' ? info.message.slice(0, 500) : '',
      };
    }) };
  }

  function switchTo(id) {
    const all = accounts();
    const account = all.find(a => a.id === id);
    if (!account) throw new Error('找不到 Claude 帳號');
    if (profileKey(account.configDir) === profileKey(currentProfile())) return { ok: true, unchanged: true, label: account.label, configDir: account.configDir };
    persist(all, account.configDir);
    return { ok: true, label: account.name || account.label, configDir: account.configDir };
  }

  function rename({ id, name }) {
    const all = accounts();
    const account = all.find(a => a.id === id);
    if (!account) throw new Error('找不到 Claude 帳號');
    account.name = String(name || '').trim().slice(0, 60);
    account.label = account.name || account.email || safeMetadata(account.configDir).email || 'Claude 帳號';
    persist(all);
    return { ok: true };
  }

  function remove(id) {
    const all = accounts();
    const account = all.find(a => a.id === id);
    if (!account) return { ok: false, message: '找不到 Claude 帳號' };
    const key = profileKey(account.configDir);
    if (key === profileKey(currentProfile())) return { ok: false, message: '請先切換到其他 Claude 帳號，再移除使用中的帳號。' };
    const ownedProfiles = new Set([account.configDir, ...(account.previousConfigDirs || [])].map(profileKey));
    if (runningProfiles().some(dir => typeof dir === 'string' && ownedProfiles.has(profileKey(dir)))) return { ok: false, message: '這個 Claude 帳號仍有回合正在執行，請等回合結束後再移除。' };
    persist(all.filter(a => a.id !== id));
    return { ok: true };
  }

  function adopt({ configDir, label, source = 'desktop', email, plan, selectionToken: expectedSelection } = {}) {
    if (typeof configDir !== 'string' || !configDir.trim()) throw new Error('Claude 登入設定資料夾無效');
    const root = path.resolve(userDir, 'claude-accounts');
    const target = path.resolve(configDir);
    const relative = path.relative(root, target);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuid.test(relative)) throw new Error('只能匯入這個 App 新建立的 Claude 帳號設定資料夾');
    let stat, real, realRoot, realUserDir;
    try { stat = fs.lstatSync(target); real = fs.realpathSync(target); realRoot = fs.realpathSync(root); realUserDir = fs.realpathSync(userDir); }
    catch { throw new Error('找不到新的 Claude 登入設定資料夾'); }
    if (!stat.isDirectory() || stat.isSymbolicLink() || profileKey(realRoot) !== profileKey(path.join(realUserDir, 'claude-accounts')) || profileKey(real) !== profileKey(path.join(realRoot, relative))) throw new Error('Claude 帳號設定資料夾位置無效');
    const all = accounts();
    let account = all.find(a => profileKey(a.configDir) === profileKey(target));
    if (!account) {
      account = { id: crypto.randomUUID(), configDir: target, label: String(label || email || 'Claude 桌面版帳號').trim().slice(0, 100) || 'Claude 桌面版帳號' };
      all.push(account);
    }
    account.source = String(source || 'desktop').slice(0, 100);
    if (typeof email === 'string') account.email = email.slice(0, 300);
    if (typeof plan === 'string') account.plan = plan.slice(0, 100);
    const activate = expectedSelection === undefined || expectedSelection === selectionVersion;
    persist(all, activate ? target : undefined);
    return { ok: true, switched: activate, label: account.name || account.label, configDir: target, account: { ...account, label: account.name || account.label, active: activate } };
  }

  async function login({ id = null, switchAfter = true, onURL = () => {} } = {}) {
    if (pending) return { ok: false, message: '已有一個 Claude 登入流程進行中，請先完成或取消。' };
    const originalAccounts = accounts();
    const original = id === null ? null : originalAccounts.find(a => a.id === id);
    if (id !== null && !original) return { ok: false, message: '找不到要重新登入的 Claude 帳號。' };
    const state = { cancelled: false, selectionVersion, profile: profileKey(currentProfile()), path: customPath() };
    pending = state;
    const stagedRoot = path.resolve(userDir, 'claude-accounts');
    const stagedDir = path.join(stagedRoot, crypto.randomUUID());
    let ownedRoot = null;
    let committed = false;
    try {
      await fsp.mkdir(stagedRoot, { recursive: true });
      ownedRoot = await fsp.realpath(stagedRoot);
      if (profileKey(ownedRoot) !== profileKey(path.join(await fsp.realpath(userDir), 'claude-accounts'))) throw new Error('Claude 帳號設定資料夾位置無效');
      await fsp.mkdir(stagedDir, { recursive: true });
      if (state.cancelled) return { ok: false, cancelled: true, message: '已取消 Claude 登入' };
      const result = await cli.login(state.path, stagedDir, onURL);
      if (state.cancelled || result.cancelled) return { ok: false, cancelled: true, message: '已取消 Claude 登入' };
      if (!result.ok) return { ok: false, message: result.message || 'Claude 登入未完成' };
      const verified = await cli.authStatus(state.path, stagedDir);
      if (state.cancelled) return { ok: false, cancelled: true, message: '已取消 Claude 登入' };
      if (!verified.ok || verified.loggedIn !== true || typeof verified.configDirectory !== 'string' || profileKey(verified.configDirectory) !== profileKey(stagedDir)) {
        return { ok: false, message: '尚未確認這次 Claude 登入成功，原帳號已保留。請完成授權後重試。' };
      }
      const all = accounts();
      let account;
      if (original) {
        account = all.find(a => a.id === original.id);
        if (!account || profileKey(account.configDir) !== profileKey(original.configDir)) return { ok: false, message: '原帳號已移除或變更，這次登入未覆寫目前設定。' };
      } else {
        account = { id: crypto.randomUUID(), label: verified.email || `Claude 帳號 ${all.length + 1}` };
        all.push(account);
      }
      if (original) account.previousConfigDirs = [...new Set([...(account.previousConfigDirs || []), account.configDir])];
      account.configDir = stagedDir;
      account.source = 'login';
      if (typeof verified.email === 'string') account.email = verified.email.slice(0, 300);
      if (typeof verified.subscriptionType === 'string') account.plan = verified.subscriptionType.slice(0, 100);
      if (!account.name && (account.name === '' || !original)) account.label = account.email || 'Claude 帳號';
      const selectionUnchanged = state.selectionVersion === selectionVersion && state.profile === profileKey(currentProfile()) && state.path === customPath();
      // A completed authorization can update its record, but cannot reverse a
      // selection the user changed while completing the browser login.
      const activate = switchAfter && selectionUnchanged;
      persist(all, activate ? stagedDir : undefined);
      committed = true;
      return { ok: true, renewed: !!original, switched: activate, message: original ? 'Claude 帳號已重新登入；正在執行的回合仍沿用原登入。' : activate ? '已登入並切換到新的 Claude 帳號。' : '已新增 Claude 帳號，目前的帳號選擇已保留。', account: { ...account, label: account.name || account.label, active: activate } };
    } catch {
      return { ok: false, message: 'Claude 登入未完成，原帳號已保留。請檢查 CLI 與登入設定後重試。' };
    } finally {
      if (pending === state) pending = null;
      if (!committed && ownedRoot) {
        // This UUID directory was created only for this attempt. Verify both
        // lexical and real paths before recursive removal; reject a replaced
        // symlink/junction or a registered/running profile.
        try {
          const relative = path.relative(stagedRoot, stagedDir);
          const real = await fsp.realpath(stagedDir);
          const expected = path.join(ownedRoot, path.basename(stagedDir));
          const stat = await fsp.lstat(stagedDir);
          const registered = (getSettings().claudeAccounts || []).some(a => typeof a?.configDir === 'string' && profileKey(a.configDir) === profileKey(stagedDir));
          const inUse = runningProfiles().some(dir => typeof dir === 'string' && profileKey(dir) === profileKey(stagedDir));
          if (/^[0-9a-f-]{36}$/i.test(relative) && !stat.isSymbolicLink() && profileKey(real) === profileKey(expected) && !registered && !inUse) {
            await fsp.rm(stagedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          }
        } catch { /* The attempted profile may already be gone or temporarily locked. */ }
      }
    }
  }

  function cancelLogin() {
    if (!pending) return { ok: true, cancelled: false };
    pending.cancelled = true;
    cli.cancelLogin();
    return { ok: true, cancelled: true };
  }

  return { list, switch: switchTo, rename, remove, adopt, login, cancelLogin, invalidate, selectionToken: () => selectionVersion };
}

module.exports = { createStore, profileKey, safeMetadata, defaultProfile };
