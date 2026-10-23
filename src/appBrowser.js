// App 內建瀏覽器：像 Codex 一樣把網頁直接顯示在 App 右側，模型用同一組 browser_* 工具操作。
// 每個分頁是一個 WebContentsView，透過 webContents.debugger 送 CDP 指令，
// 所以點擊、輸入、讀取等邏輯直接沿用 browserControl.js 的 BraveBrowser。
// 分頁依「對話」分開（scope = chat.id），A 對話看不到也操作不到 B 對話的分頁；
// 登入狀態（cookie）則共用同一個持久化 partition，登入一次即可。
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { BraveBrowser, normalizeUrl } = require('./browserControl');

const PARTITION = 'persist:cm-browser';
const CDP_TIMEOUT = 30000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}

class AppBrowserHost {
  // opts: { electron, getWindow, screenshotDir, onChange(scope), onReveal(scope), openExternal(url) }
  constructor(opts) {
    this.electron = opts.electron;
    this.getWindow = opts.getWindow;
    this.screenshotDir = opts.screenshotDir;
    this.onChange = opts.onChange || (() => {});
    this.onReveal = opts.onReveal || (() => {});
    this.openExternal = opts.openExternal || (() => {});
    this.beforeLoad = opts.beforeLoad || null; // 開網頁前先做的事（自動同步使用者 Brave 的登入）
    this.tabs = new Map();     // tabId -> { id, scope, view, wc }
    this.active = new Map();   // scope -> tabId
    this.controllers = new Map();
    this.visibleScope = null;
    this.open = false;
    this.bounds = null;
    this.seq = 0;
    this.sessionReady = false;
  }

  prepareSession() {
    if (this.sessionReady) return;
    this.sessionReady = true;
    const ses = this.electron.session.fromPartition(PARTITION);
    const allowed = new Set(['clipboard-sanitized-write', 'fullscreen']);
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
    try { ses.setUserAgent(require('./braveLogin').chromeLikeUA(ses.getUserAgent())); } catch { /* 保留預設 */ }
  }

  // 開網頁前等登入同步做完（最多 8 秒；同步失敗或逾時照樣開，只是沿用上次的登入）
  async ensureLogin() {
    if (!this.beforeLoad) return;
    try { await withTimeout(Promise.resolve().then(() => this.beforeLoad()), 8000, 'timeout'); } catch { /* 照樣開網頁 */ }
  }

  tabsOf(scope) { return [...this.tabs.values()].filter((t) => t.scope === scope); }

  activeTabOf(scope) {
    const id = this.active.get(scope);
    if (id && this.tabs.has(id)) return id;
    const first = this.tabsOf(scope)[0];
    if (first) { this.active.set(scope, first.id); return first.id; }
    return null;
  }

  setActive(scope, tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.scope !== scope) throw new Error(`找不到分頁 ${tabId}，請先用 browser_tabs 確認`);
    this.active.set(scope, tabId);
    this.layout();
    this.onChange(scope);
  }

  createTab(scope, url = 'about:blank') {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) throw new Error('App 視窗已關閉，無法開啟內建瀏覽器');
    this.prepareSession();
    const view = new this.electron.WebContentsView({
      webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
    });
    view.setBackgroundColor('#ffffff');
    const wc = view.webContents;
    const id = `tab-${Date.now().toString(36)}-${(++this.seq).toString(36)}`;
    const tab = { id, scope, view, wc };
    this.tabs.set(id, tab);
    this.active.set(scope, id);
    try { wc.debugger.attach('1.3'); } catch { /* 已附加 */ }
    const changed = () => this.onChange(scope);
    for (const ev of ['did-start-loading', 'did-stop-loading', 'page-title-updated', 'did-navigate', 'did-navigate-in-page']) wc.on(ev, changed);
    wc.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:/i.test(target)) setImmediate(() => { try { this.createTab(scope, target); this.onReveal(scope); } catch { /* 視窗已關 */ } });
      return { action: 'deny' };
    });
    wc.on('context-menu', (_e, params) => this.contextMenu(tab, params));
    wc.on('destroyed', () => { if (this.tabs.get(id) === tab) this.dropTab(tab); });
    win.contentView.addChildView(view);
    view.setBounds(this.bounds || { x: 0, y: 0, width: 1100, height: 800 });
    this.layout();
    if (url && url !== 'about:blank') this.load(tab, url);
    else wc.loadURL('about:blank').catch(() => {});
    changed();
    return tab;
  }

  load(tab, url) {
    tab.wc.loadURL(url).catch(() => { /* 取消或載入失敗：頁面本身會顯示錯誤 */ });
  }

  dropTab(tab) {
    this.tabs.delete(tab.id);
    if (this.active.get(tab.scope) === tab.id) this.active.delete(tab.scope);
    const win = this.getWindow();
    try { if (win && !win.isDestroyed()) win.contentView.removeChildView(tab.view); } catch { /* 已移除 */ }
    this.layout();
    this.onChange(tab.scope);
  }

  closeTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.dropTab(tab);
    try { if (!tab.wc.isDestroyed()) tab.wc.close(); } catch { /* 已關閉 */ }
  }

  closeScope(scope) { for (const t of this.tabsOf(scope)) this.closeTab(t.id); }

  // 只顯示「目前畫面上的對話」的作用中分頁，其餘分頁隱藏但保持可操作
  layout() {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;
    const shownId = this.open && this.bounds && this.visibleScope ? this.activeTabOf(this.visibleScope) : null;
    for (const tab of this.tabs.values()) {
      if (tab.wc.isDestroyed()) continue;
      const show = tab.id === shownId;
      if (show) {
        tab.view.setBounds(this.bounds);
        win.contentView.addChildView(tab.view); // 移到最上層
      }
      tab.view.setVisible(show);
    }
  }

  show({ scope, open, bounds }) {
    this.visibleScope = scope || null;
    this.open = !!open;
    if (bounds && bounds.width > 20 && bounds.height > 20) {
      this.bounds = { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) };
    }
    this.layout();
    return this.state(scope);
  }

  state(scope) {
    const activeId = scope ? this.activeTabOf(scope) : null;
    return {
      scope: scope || null,
      tabs: scope ? this.tabsOf(scope).filter((t) => !t.wc.isDestroyed()).map((t) => ({
        tabId: t.id,
        title: t.wc.getTitle() || '',
        url: t.wc.getURL() || '',
        active: t.id === activeId,
        loading: t.wc.isLoading(),
        canBack: t.wc.navigationHistory.canGoBack(),
        canForward: t.wc.navigationHistory.canGoForward(),
      })) : [],
    };
  }

  // 使用者在面板上的操作
  action(scope, { action, tabId, url }) {
    if (!scope) throw new Error('請先開啟一段對話');
    const id = tabId || this.activeTabOf(scope);
    const tab = id ? this.tabs.get(id) : null;
    if (tab && tab.scope !== scope) throw new Error('這個分頁不屬於目前的對話');
    const nav = tab && tab.wc.navigationHistory;
    switch (action) {
      case 'navigate': {
        const target = normalizeUrl(url);
        if (tab) { this.load(tab, target); this.active.set(scope, tab.id); } else this.createTab(scope, target);
        break;
      }
      case 'newTab': this.createTab(scope, url ? normalizeUrl(url) : 'about:blank'); break;
      case 'select': this.setActive(scope, id); break;
      case 'close': if (tab) this.closeTab(tab.id); break;
      case 'back': if (nav && nav.canGoBack()) nav.goBack(); break;
      case 'forward': if (nav && nav.canGoForward()) nav.goForward(); break;
      case 'reload': if (tab) { if (tab.wc.isLoading()) tab.wc.stop(); else tab.wc.reload(); } break;
      case 'external': if (tab && /^https?:/i.test(tab.wc.getURL())) this.openExternal(tab.wc.getURL()); break;
      case 'devtools': if (tab) tab.wc.openDevTools({ mode: 'detach' }); break;
      default: throw new Error(`不支援的操作：${action}`);
    }
    this.layout();
    this.onChange(scope);
    return this.state(scope);
  }

  contextMenu(tab, params) {
    const { Menu, clipboard } = this.electron;
    const nav = tab.wc.navigationHistory;
    const t = [
      { label: '上一頁', enabled: nav.canGoBack(), click: () => nav.goBack() },
      { label: '下一頁', enabled: nav.canGoForward(), click: () => nav.goForward() },
      { label: '重新整理', click: () => tab.wc.reload() },
      { type: 'separator' },
    ];
    if (params.isEditable) t.push({ label: '剪下', role: 'cut' }, { label: '複製', role: 'copy' }, { label: '貼上', role: 'paste' }, { label: '全選', role: 'selectAll' });
    else t.push({ label: '複製', role: 'copy', enabled: !!params.selectionText }, { label: '全選', role: 'selectAll' });
    if (params.linkURL && /^https?:/i.test(params.linkURL)) {
      t.push({ type: 'separator' },
        { label: '在新分頁開啟連結', click: () => { this.createTab(tab.scope, params.linkURL); } },
        { label: '複製連結網址', click: () => clipboard.writeText(params.linkURL) },
        { label: '用系統瀏覽器開啟連結', click: () => this.openExternal(params.linkURL) });
    }
    if (params.srcURL && params.mediaType === 'image') t.push({ type: 'separator' }, { label: '複製圖片', click: () => tab.wc.copyImageAt(params.x, params.y) });
    t.push({ type: 'separator' }, { label: '檢查元素', click: () => tab.wc.inspectElement(params.x, params.y) });
    Menu.buildFromTemplate(t).popup({ window: this.getWindow() });
  }

  controller(scope) {
    scope = String(scope);
    let c = this.controllers.get(scope);
    if (!c) { c = createScopeController(new AppScopeBrowser(this, scope)); this.controllers.set(scope, c); }
    return c;
  }

  destroyAll() {
    for (const t of [...this.tabs.values()]) this.closeTab(t.id);
  }
}

// 讓 BraveBrowser 的邏輯改用 app 內的分頁：sessionId 就是 tabId
class AppScopeBrowser extends BraveBrowser {
  constructor(host, scope) {
    super({ screenshotDir: host.screenshotDir });
    this.host = host;
    this.scope = scope;
    this.version = { Browser: 'Codex Multi 內建瀏覽器' };
    this.conn = {
      send: (method, params = {}, sessionId) => {
        if (!sessionId) {
          if (method === 'Browser.close') return Promise.resolve({});
          return Promise.reject(new Error(`內建瀏覽器不支援 ${method}`));
        }
        const tab = this.host.tabs.get(sessionId);
        if (!tab || tab.wc.isDestroyed() || tab.scope !== this.scope) return Promise.reject(new Error('分頁已經關閉，請重新用 browser_open 開啟'));
        return withTimeout(tab.wc.debugger.sendCommand(method, params), CDP_TIMEOUT, `頁面沒有回應（${method}）`);
      },
      close: () => {},
    };
  }

  get activeTab() { return this.host ? this.host.activeTabOf(this.scope) : null; }
  set activeTab(id) { if (this.host && id) this.host.active.set(this.scope, id); }

  info() {
    return { running: true, engine: 'app', browser: '內建瀏覽器', port: null, profileDir: '', bravePath: '', tabs: this.host.tabsOf(this.scope).length };
  }

  async start() { return this.info(); }

  async targets() {
    return this.host.tabsOf(this.scope).filter((t) => !t.wc.isDestroyed()).map((t) => ({ targetId: t.id, type: 'page', title: t.wc.getTitle(), url: t.wc.getURL() }));
  }

  async session(targetId) {
    const tab = this.host.tabs.get(targetId);
    if (!tab || tab.scope !== this.scope) throw new Error(`找不到分頁 ${targetId}，請先用 browser_tabs 確認`);
    this.sessions.set(targetId, targetId);
    return targetId;
  }

  async ensurePage() {
    let id = this.host.activeTabOf(this.scope);
    if (!id) id = this.host.createTab(this.scope).id;
    this.sessions.set(id, id);
    return id;
  }

  async use(tabId) {
    if (tabId) {
      await this.session(tabId);
      this.host.setActive(this.scope, tabId);
      return tabId;
    }
    return this.ensurePage();
  }

  async open(input, { newTab = false } = {}) {
    const url = normalizeUrl(input);
    await this.host.ensureLogin();
    let tab;
    const current = this.host.activeTabOf(this.scope);
    if (newTab || !current) tab = this.host.createTab(this.scope, url);
    else { tab = this.host.tabs.get(current); this.host.load(tab, url); }
    this.sessions.set(tab.id, tab.id);
    this.host.setActive(this.scope, tab.id);
    this.host.onReveal(this.scope);
    await sleep(150);
    await this.waitReady(tab.id, 25000, url);
    return { tabId: tab.id, url: tab.wc.getURL() || url, title: tab.wc.getTitle() || '' };
  }

  async screenshot({ tabId, full = false } = {}) {
    const id = await this.use(tabId);
    const tab = this.host.tabs.get(id);
    let buffer = null;
    if (full) {
      try {
        const r = await withTimeout(tab.wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }), 10000, 'timeout');
        buffer = Buffer.from((r && r.data) || '', 'base64');
      } catch { buffer = null; }
    }
    if (!buffer || !buffer.length) {
      const image = await tab.wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
      buffer = image.toPNG();
    }
    if (!buffer.length) throw new Error('截圖失敗（頁面沒有回傳畫面）');
    fs.mkdirSync(this.screenshotDir, { recursive: true });
    const file = path.join(this.screenshotDir, `page-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
    await fsp.writeFile(file, buffer);
    return { path: file, bytes: buffer.length };
  }

  async closeTab({ tabId } = {}) {
    const id = tabId || this.host.activeTabOf(this.scope);
    if (!id) return { ok: true };
    await this.session(id);
    this.sessions.delete(id);
    this.host.closeTab(id);
    return { ok: true };
  }

  async stop() {
    this.host.closeScope(this.scope);
    this.sessions.clear();
    return { ok: true, running: false };
  }
}

// 與 browserControl.createController 相同的介面，apiTools / MCP 橋接不用改
function createScopeController(browser) {
  let activeGuard = null;
  const call = (fn) => {
    const guard = activeGuard;
    return browser.enqueue(async () => {
      if (guard && !guard()) throw new Error('已停止');
      return fn();
    });
  };
  return {
    browser,
    setGuard: (guard) => { activeGuard = guard; },
    info: () => browser.info(),
    start: () => call(() => browser.start()),
    stop: () => call(() => browser.stop()),
    tabs: () => call(() => browser.tabs()),
    open: (args) => call(() => browser.open(args.url, { newTab: !!args.newTab })),
    read: (args) => call(() => browser.read(args)),
    snapshot: (args) => call(() => browser.snapshot(args)),
    click: (args) => call(() => browser.click(args)),
    type: (args) => call(() => browser.type(args)),
    press: (args) => call(() => browser.pressKey(args.key, args.tabId)),
    scroll: (args) => call(() => browser.scroll(args)),
    back: (args = {}) => call(() => browser.history({ tabId: args.tabId, direction: 'back' })),
    forward: (args = {}) => call(() => browser.history({ tabId: args.tabId, direction: 'forward' })),
    wait: (args) => call(() => browser.waitFor(args)),
    screenshot: (args) => call(() => browser.screenshot(args)),
    closeTab: (args) => call(() => browser.closeTab(args)),
    evalRaw: (expression, args) => call(() => browser.evalRaw(expression, args)),
  };
}

module.exports = { AppBrowserHost, AppScopeBrowser, createScopeController, PARTITION };
