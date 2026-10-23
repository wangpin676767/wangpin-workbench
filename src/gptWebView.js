'use strict';

const HOME = 'https://chatgpt.com/';
const PARTITION = 'persist:cm-chatgpt';
const AUTH_HOSTS = ['auth.openai.com', 'auth0.openai.com', 'accounts.openai.com', 'accounts.google.com', 'appleid.apple.com', 'account.apple.com', 'login.microsoftonline.com', 'login.live.com'];
function allowedUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && ['chatgpt.com', ...AUTH_HOSTS].includes(u.hostname); } catch { return false; }
}
function authUrl(value) { try { const u = new URL(value); return AUTH_HOSTS.includes(u.hostname) || (u.hostname === 'chatgpt.com' && u.pathname.startsWith('/auth/')); } catch { return false; } }
function conversationUrl(value, temporary) {
  return /^https:\/\/chatgpt\.com\/(?:g\/[^/]+\/)?c\//.test(value || '') ? value : HOME + (temporary ? '?temporary-chat=true' : '');
}
function diagnosticMessage(value) {
  return String(value || 'ChatGPT page failed to load').replace(/https?:\/\/[^\s'"<>]+/g, address => { try { return new URL(address).hostname; } catch { return '[website]'; } });
}

class GptWebViewHost {
  constructor({ electron, getWindow, openExternal = () => {}, onChange = () => {}, maxViews = 2, idleMs = 120000, loadTimeoutMs = 30000 }) {
    Object.assign(this, { electron, getWindow, openExternal, onChange, maxViews, loadTimeoutMs });
    this.views = new Map(); this.visibleKey = null; this.bounds = null; this.open = false;
    this.idleTimer = setInterval(() => {
      for (const item of this.views.values()) if (!item.leases && !(this.open && item.key === this.visibleKey) && Date.now() - item.usedAt > idleMs) this.closeSession(item.key);
    }, Math.min(idleMs, 30000));
    this.idleTimer.unref?.();
  }
  report(item) {
    if (this.views.get(item.key) === item && item.key === this.visibleKey) this.onChange({ chatKey: item.key, key: item.uiKey || null, login: item.key === '__login__', status: item.status, error: item.error || null });
  }
  fail(item, code, message) {
    if (this.views.get(item.key) !== item) return;
    item.status = 'error'; item.error = { code: String(code || 'GPTWEB_LOAD_FAILED'), message: diagnosticMessage(message) };
    this.layout(); this.report(item);
  }
  async load(item, url) {
    const revision = item.loadRevision = (item.loadRevision || 0) + 1;
    item.status = 'loading'; item.error = null; this.layout(); this.report(item);
    let timeout;
    try {
      await Promise.race([item.wc.loadURL(url), new Promise((_, reject) => { timeout = setTimeout(() => { if (item.loadRevision === revision && this.views.get(item.key) === item && !item.wc.isDestroyed()) item.wc.stop?.(); const error = new Error('ChatGPT 網頁載入逾時，請檢查網路後重試。'); error.code = 'GPTWEB_LOAD_TIMEOUT'; reject(error); }, this.loadTimeoutMs); })]);
      if (item.loadRevision !== revision) return await item.loading;
      if (item.status === 'error') { const error = new Error(item.error.message); error.code = item.error.code; throw error; }
      item.status = 'ready'; this.layout(); this.report(item);
    } catch (error) {
      if (item.loadRevision !== revision) return await item.loading;
      this.fail(item, error.code, error.message);
      const failure = new Error(diagnosticMessage(error.message)); failure.code = error.code; throw failure;
    }
    finally { clearTimeout(timeout); }
  }
  async ensure({ chatKey = '__login__', url, temporary = false, uiKey } = {}) {
    if (!chatKey || typeof chatKey !== 'string') throw new Error('Missing ChatGPT conversation key');
    let item = this.views.get(chatKey);
    if (item && !item.wc.isDestroyed()) {
      item.usedAt = Date.now(); await item.loading;
      const wanted = conversationUrl(url, temporary);
      if (url && wanted !== HOME && wanted !== item.wc.getURL() && !item.leases) {
        item.loading = this.load(item, wanted); await item.loading;
      }
      return item;
    }
    if (this.views.size >= this.maxViews) {
      const idle = [...this.views.values()].filter(v => !v.leases && v.key !== this.visibleKey).sort((a, b) => a.usedAt - b.usedAt)[0];
      if (!idle) throw new Error('ChatGPT conversations are busy; wait for one to finish.');
      this.closeSession(idle.key);
    }
    const win = this.getWindow();
    if (!win || win.isDestroyed()) throw new Error('App window is closed');
    const ses = this.electron.session.fromPartition(PARTITION);
    if (!this.sessionReady) {
      ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
      ses.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');
      this.sessionReady = true;
    }
    const view = new this.electron.WebContentsView({ webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: true } });
    view.setBackgroundColor?.('#ffffff');
    const wc = view.webContents;
    item = { key: chatKey, uiKey, view, wc, usedAt: Date.now(), leases: 0, loading: null, status: 'loading', error: null };
    this.views.set(chatKey, item);
    win.contentView.addChildView(view); view.setVisible(false); this.layout();
    const outside = target => {
      if (authUrl(wc.getURL()) || item.authFlow) {
        this.fail(item, 'GPTWEB_AUTH_REDIRECT_UNSUPPORTED', '登入跳轉無法在 App 中完成；已阻止將登入工作階段送到 Brave。請重試並選擇登入頁提供的其他方式。');
      } else if (/^https?:/.test(target)) this.openExternal(target);
    };
    const navigation = (event, target) => {
      if (!allowedUrl(target)) { event.preventDefault(); outside(target); }
      else if (authUrl(target)) item.authFlow = true;
    };
    wc.on('will-navigate', navigation); wc.on('will-redirect', navigation);
    wc.setWindowOpenHandler(({ url: target }) => {
      if (allowedUrl(target)) { if (authUrl(target)) item.authFlow = true; item.loading = this.load(item, target); item.loading.catch(() => {}); } else outside(target);
      return { action: 'deny' };
    });
    for (const event of ['did-navigate', 'did-navigate-in-page', 'did-stop-loading']) wc.on(event, () => this.report(item));
    wc.on('did-navigate', (_event, url) => { try { const u = new URL(url); if (u.hostname === 'chatgpt.com' && !u.pathname.startsWith('/auth/')) item.authFlow = false; } catch {} });
    wc.on('did-fail-load', (_event, code, description, _url, isMainFrame) => { if (isMainFrame !== false && code !== -3) this.fail(item, `NET_${code}`, description); });
    wc.on('render-process-gone', (_event, details) => this.fail(item, 'GPTWEB_RENDER_PROCESS_GONE', details?.reason || 'ChatGPT renderer stopped'));
    wc.on('destroyed', () => { if (this.views.get(chatKey) === item) this.views.delete(chatKey); });
    item.loading = this.load(item, conversationUrl(url, temporary));
    await item.loading;
    return item;
  }
  async openSession(options = {}) {
    const item = await this.ensure(options); item.leases++;
    const wc = item.wc;
    try { if (!wc.debugger.isAttached()) wc.debugger.attach('1.3'); } catch (error) { item.leases--; throw error; }
    wc.setBackgroundThrottling?.(false);
    const conn = {
      send: async (method, params = {}, sessionId) => {
        if (method === 'Target.closeTarget') { this.closeSession(item.key); return {}; }
        if (method === 'Page.navigate') { if (!allowedUrl(params.url)) throw new Error('Unsupported ChatGPT URL'); item.loading = this.load(item, params.url); await item.loading; return {}; }
        return wc.debugger.sendCommand(method, params, sessionId || undefined);
      },
      close() {},
    };
    const tab = { conn, targetId: item.key, sessionId: null,
      async eval(expression) {
        const r = await conn.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'ChatGPT page script failed');
        return r.result?.value;
      }, navigate: url => conn.send('Page.navigate', { url }),
    };
    let released = false;
    return { conn, tab, hidden: true, release: () => { if (!released) { released = true; item.leases = Math.max(0, item.leases - 1); item.usedAt = Date.now(); if (!wc.isDestroyed()) this.layout(); } } };
  }
  async show({ chatKey, url, visible = true, bounds, retry = false, uiKey, startLogin = false } = {}) {
    this.visibleKey = chatKey || null; this.open = !!visible; this.bounds = bounds || null;
    this.layout();
    if (!visible || !chatKey) return { ok: true };
    const existing = this.views.get(chatKey);
    if (retry && existing) { if (existing.leases) throw new Error('ChatGPT 正在回覆，請稍後重試。'); this.closeSession(chatKey); }
    const item = await this.ensure({ chatKey, url, uiKey }); item.uiKey = uiKey;
    this.layout(); this.report(item);
    if (startLogin) return { ok: true, chatKey, status: item.status, auth: await this.beginLogin(item) };
    return { ok: true, chatKey, status: item.status, auth: await this.status(item) };
  }
  layout() {
    const win = this.getWindow();
    const [width, height] = win && !win.isDestroyed() ? win.getContentSize() : [0, 0];
    const b = this.bounds || {};
    const valid = ['x', 'y', 'width', 'height'].every(k => Number.isFinite(b[k]));
    const x = valid ? Math.max(0, Math.min(width, Math.round(b.x))) : 0;
    const y = valid ? Math.max(0, Math.min(height, Math.round(b.y))) : 0;
    const rect = { x, y, width: valid ? Math.max(0, Math.min(width - x, Math.round(b.width))) : 0, height: valid ? Math.max(0, Math.min(height - y, Math.round(b.height))) : 0 };
    for (const item of this.views.values()) {
      const visible = this.open && item.key === this.visibleKey && item.status !== 'error' && rect.width > 0 && rect.height > 0;
      if (visible) item.view.setBounds(rect);
      item.view.setVisible(visible);
      item.wc.setBackgroundThrottling?.(!(visible || item.leases));
    }
  }
  async status(item = this.views.get(this.visibleKey)) {
    let loggedIn = null;
    if (item && !item.wc.isDestroyed()) try {
      const result = await item.wc.executeJavaScript(`(() => {
        const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
        const login = [...document.querySelectorAll('button,a,[role="button"]')].some(el => visible(el) && (el.matches('[data-testid="login-button"]') || /^(log\\s*in|sign\\s*in|登入|登錄|登录)$/i.test(el.textContent.trim())));
        if (login) return false;
        if (['[data-testid="sidebar-profile-button"]','[data-testid="user-menu-button"]','button[aria-label="Open profile menu"]'].some(s => visible(document.querySelector(s)))) return true;
        return null;
      })()`);
      if (result === true || result === false) loggedIn = result;
    } catch {}
    return { ok: loggedIn === true, embedded: true, loggedIn, message: loggedIn === true ? '已登入 ChatGPT；登入狀態會保存在 App。' : loggedIn === false ? '尚未登入：按「登入 ChatGPT」，完成後按「檢查登入」。App 與 Brave 分別保存登入資料。' : '尚無法確認登入狀態；請完成網頁登入後按「檢查登入」。App 與 Brave 分別保存登入資料。' };
  }
  async beginLogin(item = this.views.get(this.visibleKey)) {
    if (!item || item.wc.isDestroyed()) throw new Error('請先開啟 ChatGPT 網頁。');
    if (!this.open || this.visibleKey !== item.key || this.views.get(item.key) !== item) throw new Error('對話已切換，請在目前對話重新按登入。');
    if (item.leases) throw new Error('ChatGPT 正在回覆，請等回覆完成再登入。');
    const auth = await this.status(item);
    if (!this.open || this.visibleKey !== item.key) throw new Error('對話已切換，請在目前對話重新按登入。');
    if (auth.loggedIn === true) return auth;
    item.authFlow = true;
    const clicked = await item.wc.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll('button,a,[role="button"]')].find(el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && (el.matches('[data-testid="login-button"]') || /^(log\\s*in|sign\\s*in|登入|登錄|登录)$/i.test(el.textContent.trim())));
      if (!button) return false;
      button.click(); return true;
    })()`, true);
    return { ok: false, loggedIn: null, pending: true, message: clicked ? '已開啟登入流程：請在上方網頁完成登入，再按「檢查登入」。登入資料會留在 App；Brave 的登入不會自動帶入。' : '請在上方網頁完成登入，再按「檢查登入」。若第三方登入拒絕內嵌瀏覽器，App 無法從 Brave 接回登入；請使用網頁提供的其他登入方式。' };
  }
  closeSession(key) {
    const item = this.views.get(key); if (!item) return;
    this.views.delete(key);
    const win = this.getWindow(); if (win && !win.isDestroyed()) try { win.contentView.removeChildView(item.view); } catch {}
    if (!item.wc.isDestroyed()) item.wc.close();
  }
  destroyAll() { clearInterval(this.idleTimer); for (const key of [...this.views.keys()]) this.closeSession(key); }
}
module.exports = { GptWebViewHost, PARTITION, allowedUrl, conversationUrl };
