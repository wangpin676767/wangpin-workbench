// 直接用 Chrome DevTools Protocol 控制 Brave，不需要安裝額外套件。
// Brave 是 Chromium 系瀏覽器，用 --remote-debugging-port 開一個除錯埠後，
// 就能用 Runtime/Input/Page 這幾個網域操作頁面（等同 Codex 的瀏覽器工具）。
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const net = require('net');
const path = require('path');

const SEND_TIMEOUT = 30000;
const CONNECT_TIMEOUT = 30000;
const LAUNCH_TIMEOUT = 40000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 無頭 Brave 的身分字串與 Client Hints 改成一般桌面版 Chrome */
function headfulUA(version) {
  const ua = String((version && version['User-Agent']) || '').replace(/HeadlessChrome/g, 'Chrome');
  const full = (/Chrome\/([\d.]+)/.exec(String((version && version.Browser) || '')) || [])[1] || (/Chrome\/([\d.]+)/.exec(ua) || [])[1] || '120.0.0.0';
  const major = full.split('.')[0];
  return {
    userAgent: ua || `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    acceptLanguage: 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    platform: 'Win32',
    userAgentMetadata: {
      brands: [{ brand: 'Chromium', version: major }, { brand: 'Brave', version: major }, { brand: 'Not.A/Brand', version: '99' }],
      fullVersionList: [{ brand: 'Chromium', version: full }, { brand: 'Brave', version: full }, { brand: 'Not.A/Brand', version: '99.0.0.0' }],
      fullVersion: full, platform: 'Windows', platformVersion: '10.0.0', architecture: 'x86', model: '', mobile: false, bitness: '64', wow64: false,
    },
  };
}

/** Storage.getCookies 的結果轉成 Storage.setCookies 接受的 CookieParam */
function toCookieParam(c) {
  if (!c || !c.name || !c.domain) return null;
  const p = { name: c.name, value: c.value == null ? '' : String(c.value), domain: c.domain, path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly };
  if (c.sameSite) p.sameSite = c.sameSite;
  if (!c.session && Number(c.expires) > 0) p.expires = Number(c.expires);
  if (c.priority) p.priority = c.priority;
  if (c.sourceScheme) p.sourceScheme = c.sourceScheme;
  if (Number.isInteger(c.sourcePort)) p.sourcePort = c.sourcePort;
  if (c.partitionKey && typeof c.partitionKey === 'object') p.partitionKey = c.partitionKey;
  return p;
}

// Brave 的安裝位置（Windows；順便涵蓋 Beta／Nightly）
function braveCandidates() {
  const list = [];
  for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
    if (!base) continue;
    for (const dir of ['Brave-Browser', 'Brave-Browser-Beta', 'Brave-Browser-Nightly']) list.push(path.join(base, 'BraveSoftware', dir, 'Application', 'brave.exe'));
  }
  return list;
}

// 其他 Chromium 系瀏覽器（同樣支援除錯埠）：只給工作台自己的獨立瀏覽器當備案，換電腦沒裝 Brave 時仍能用
function fallbackCandidates() {
  const list = [];
  for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
    if (!base) continue;
    list.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    list.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  return list;
}

function findBrave(custom, { fallback = false } = {}) {
  const tried = [];
  for (const candidate of [custom, ...braveCandidates(), ...(fallback ? fallbackCandidates() : [])]) {
    if (!candidate) continue;
    tried.push(candidate);
    try { if (fs.statSync(candidate).isFile()) return { path: candidate, tried }; } catch { /* 不存在就換下一個 */ }
  }
  return { path: '', tried };
}

// 使用者平常用的 Brave 設定檔（登入狀態、密碼、擴充都在這裡）
function userDataDir() {
  const base = process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local');
  return path.join(base, 'BraveSoftware', 'Brave-Browser', 'User Data');
}

// 找出「用這個設定檔、開了除錯埠」的 Brave 主程序：先看 DevToolsActivePort（埠號 0 時才會寫），
// 再看 brave.exe 的命令列（使用者自己用 --remote-debugging-port=9222 開的就是這種）
function braveProcessPorts(dir) {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"name='brave.exe'\" | ForEach-Object { $_.CommandLine }"],
    { windowsHide: true, timeout: 10000, maxBuffer: 4 << 20 }, (err, stdout) => {
      if (err) { resolve([]); return; }
      const want = path.resolve(dir).toLowerCase();
      const ports = [];
      for (const line of String(stdout).split(/\r?\n/)) {
        if (!line || /--type=/.test(line)) continue;
        const m = /--remote-debugging-port=(\d+)/.exec(line);
        if (!m) continue;
        const d = /--user-data-dir=(?:"([^"]+)"|(\S+))/.exec(line);
        const used = d ? path.resolve(d[1] || d[2]).toLowerCase() : want; // 沒指定就是預設設定檔
        if (used === want) ports.push(Number(m[1]));
      }
      resolve(ports);
    });
  });
}

async function userBravePort(dir = userDataDir()) {
  const ports = [];
  try { const first = Number(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]); if (first) ports.push(first); } catch { /* 沒有這個檔 */ }
  for (const port of await braveProcessPorts(dir)) if (!ports.includes(port)) ports.push(port);
  for (const port of ports) {
    const version = await probeVersion(port);
    if (version) return { port, version };
  }
  return null;
}

// Chromium 執行時會獨占 User Data\\lockfile；打得開就代表沒有在跑
function profileInUse(dir = userDataDir()) {
  const lock = path.join(dir, 'lockfile');
  if (!fs.existsSync(lock)) return false;
  try { fs.closeSync(fs.openSync(lock, 'r+')); return false; } catch (e) { return e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES'; }
}

function httpJson(url, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (err) { reject(err); } });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('逾時')));
  });
}

async function probeVersion(port) {
  if (!port) return null;
  try {
    const v = await httpJson(`http://127.0.0.1:${port}/json/version`, 1500);
    return v && v.webSocketDebuggerUrl ? v : null;
  } catch { return null; }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

const ALLOWED_SCHEMES = /^(https?|file|data|about|chrome|brave|edge|view-source):/i;

// 使用者說「開 brave 查 xxx」時，沒有網址就當成搜尋關鍵字
function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('請提供網址或搜尋關鍵字');
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    if (!ALLOWED_SCHEMES.test(raw)) throw new Error(`不支援這種連結：${raw.split(':')[0]}:`);
    return raw;
  }
  if (/[\s\u4e00-\u9fff]/.test(raw) || !/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(raw)) return `https://search.brave.com/search?q=${encodeURIComponent(raw)}`;
  return `https://${raw}`;
}

// 找頁面上可互動的元素，標上 data-cm-idx 讓後續點擊／輸入可以精準命中
const SNAPSHOT_SCRIPT = `(function(max){
  var sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=textbox],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[contenteditable=""],[contenteditable="true"],[onclick]';
  var nodes = document.querySelectorAll(sel), out = [], i, el, r, st, label;
  for (i = 0; i < nodes.length && out.length < max; i++) {
    el = nodes[i];
    r = el.getBoundingClientRect();
    st = window.getComputedStyle(el);
    if (r.width < 2 || r.height < 2) continue;
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 0.05) continue;
    if (el.getAttribute('aria-hidden') === 'true') continue;
    label = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
    el.setAttribute('data-cm-idx', String(out.length));
    out.push({ idx: out.length, tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', label: label, disabled: !!el.disabled });
  }
  return { title: document.title, url: location.href, total: nodes.length, elements: out, text: (document.body ? document.body.innerText : '').slice(0, 4000) };
})`;

const RESOLVE_SCRIPT = `(function(target){
  var el = null, i, t, nodes, needle;
  if (target.index !== null && target.index !== undefined) el = document.querySelector('[data-cm-idx="' + target.index + '"]');
  if (!el && target.selector) { try { el = document.querySelector(target.selector); } catch (e) { return { error: '選擇器無效：' + e.message }; } }
  if (!el && target.text) {
    nodes = document.querySelectorAll('a[href],button,input,select,textarea,summary,[role=button],[role=link],[onclick]');
    needle = String(target.text).toLowerCase();
    for (i = 0; i < nodes.length; i++) {
      t = (nodes[i].innerText || nodes[i].value || nodes[i].getAttribute('aria-label') || nodes[i].getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      if (t && t.indexOf(needle) >= 0) { el = nodes[i]; break; }
    }
  }
  if (!el) return { error: '找不到符合的元素，請先用 browser_snapshot 看目前頁面有哪些元素' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  var r = el.getBoundingClientRect();
  var desc = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.tagName).replace(/\\s+/g, ' ').trim().slice(0, 80);
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), tag: el.tagName.toLowerCase(), desc: desc };
})`;

const FOCUS_SCRIPT = `(function(target){
  var el = null;
  if (target.index !== null && target.index !== undefined) el = document.querySelector('[data-cm-idx="' + target.index + '"]');
  if (!el && target.selector) { try { el = document.querySelector(target.selector); } catch (e) { return { error: '選擇器無效：' + e.message }; } }
  if (!el) el = document.activeElement;
  if (!el || el === document.body) return { error: '找不到輸入框，請提供 index 或 selector' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.focus();
  if (typeof el.select === 'function' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) el.select();
  var desc = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.tagName).slice(0, 80);
  return { ok: true, desc: desc };
})`;

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 },
};

function keySpec(key) {
  const name = String(key || '').trim();
  if (KEYS[name]) return KEYS[name];
  if (name.length === 1) {
    const upper = name.toUpperCase();
    return { key: name, code: /[a-z]/i.test(name) ? `Key${upper}` : name, windowsVirtualKeyCode: upper.charCodeAt(0) };
  }
  return null;
}

// 一條 WebSocket 對多個分頁：用 flatten session 分別對每個分頁下指令
class CdpConnection {
  constructor(wsUrl, WebSocketImpl) {
    this.wsUrl = wsUrl;
    this.WebSocketImpl = WebSocketImpl || globalThis.WebSocket;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.closedReason = '';
  }

  async open() {
    if (typeof this.WebSocketImpl !== 'function') throw new Error('這個執行環境沒有 WebSocket，無法控制瀏覽器');
    const ws = new this.WebSocketImpl(this.wsUrl);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('連接瀏覽器除錯埠逾時')), CONNECT_TIMEOUT);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('無法連接瀏覽器除錯埠')); }, { once: true });
    });
    ws.addEventListener('message', (ev) => this.onMessage(ev));
    ws.addEventListener('close', () => {
      this.closedReason = this.closedReason || '瀏覽器連線已中斷（可能被關閉了）';
      for (const p of this.pending.values()) p.reject(new Error(this.closedReason));
      this.pending.clear();
    });
    return this;
  }

  onMessage(ev) {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method} 失敗：${msg.error.message || JSON.stringify(msg.error)}`));
      else p.resolve(msg.result);
      return;
    }
    if (!msg.method) return;
    const set = this.handlers.get(msg.method);
    if (!set) return;
    for (const h of set) { try { h(msg.params || {}, msg.sessionId); } catch { /* 事件處理失敗不影響指令 */ } }
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(handler);
  }

  send(method, params = {}, sessionId) {
    if (this.actionGuard && !this.actionGuard()) return Promise.reject(new Error('已停止'));
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error(this.closedReason || '瀏覽器連線中斷'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 逾時`)); }, SEND_TIMEOUT);
      this.pending.set(id, {
        method,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  close() { try { if (this.ws) this.ws.close(); } catch { /* 已關閉 */ } this.ws = null; }
}

// 控制一個 Brave 實例：需要時啟動，之後重複使用同一個除錯埠
class BraveBrowser {
  constructor(opts = {}) {
    this.bravePath = opts.bravePath || '';
    this.strictExecutable = !!opts.strictExecutable;
    this.profileDir = opts.profileDir || '';
    this.stateFile = opts.stateFile || '';
    this.verifyEndpoint = typeof opts.verifyEndpoint === 'function' ? opts.verifyEndpoint : null;
    this.port = Number(opts.port) || 0;
    this.headless = !!opts.headless;
    this.offscreen = !!opts.offscreen;
    this.fallbackBrowsers = !!opts.fallbackBrowsers;
    this.launchTimeoutMs = Number(opts.launchTimeoutMs) || LAUNCH_TIMEOUT;
    // userProfile：用使用者平常的 Brave 設定檔（沿用登入）；background：分頁在背景開、不搶焦點
    this.userProfile = !!opts.userProfile;
    this.background = opts.background !== false;
    // 背景模式下工作台自己的 Brave 用無頭方式跑：Windows 上 Chromium 不理會「隱藏／最小化啟動」，
    // 一開就會搶走前景（實測 SW_HIDE、start /min 都一樣），只有無頭模式完全不出視窗。
    this.hidden = !this.headless && this.background && !this.userProfile;
    // 每開一個新的瀏覽情境（各對話各一個）要做的準備，例如把使用者 Brave 的登入 cookie 帶進去
    this.prepareContext = typeof opts.prepareContext === 'function' ? opts.prepareContext : null;
    this.ownTabs = null;
    this.allOwnTabs = new Set(); // 所有對話開過的分頁（停止時一起收掉）
    this.extraArgs = Array.isArray(opts.extraArgs) ? opts.extraArgs : [];
    this.WebSocketImpl = opts.WebSocketImpl;
    this.log = typeof opts.log === 'function' ? opts.log : () => {};
    this.screenshotDir = opts.screenshotDir || '';
    this.conn = null;
    this.sessions = new Map();
    this.activeTab = null;
    this.version = null;
    this.queue = Promise.resolve();
    this.owned = false;
  }

  enqueue(fn) {
    const run = this.queue.then(() => fn());
    this.queue = run.then(() => {}, () => {});
    return run;
  }

  readState() {
    if (!this.stateFile) return null;
    try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { return null; }
  }

  writeState() {
    if (!this.stateFile) return;
    try { fs.writeFileSync(this.stateFile, JSON.stringify({ port: this.port, profileDir: this.profileDir, noWindow: this.noWindow, at: Date.now() }), 'utf8'); } catch { /* 寫不進去就算了 */ }
  }

  // 使用者把 Brave 關掉、或它自己當掉時，連線會斷。之後的呼叫要重新接上／重新啟動，
  // 不能一直回「連線已中斷」。
  get live() { return !!(this.conn && (!this.conn.ws || this.conn.ws.readyState === 1)); }

  forgetConnection() {
    try { if (this.conn) this.conn.close(); } catch { /* 已關閉 */ }
    this.conn = null;
    this.sessions = new Map();
    this.activeTab = null;
    this.version = null;
  }

  get noWindow() { return this.headless || this.hidden; }

  info() {
    return {
      running: this.live,
      hidden: this.hidden,
      port: this.port || null,
      profileDir: this.profileDir,
      bravePath: this.bravePath,
      browser: this.version ? this.version.Browser : '',
      tabs: this.sessions.size,
    };
  }

  async start() {
    if (this.strictExecutable) {
      try { if (!this.bravePath || !fs.statSync(this.bravePath).isFile()) throw Error('missing'); }
      catch { throw Error('指定瀏覽器執行檔不存在；不會改用其他瀏覽器。'); }
    }
    if (this.live) return this.info();
    if (this.conn) { this.log('瀏覽器連線已中斷，重新連線'); this.forgetConnection(); }
    if (this.userProfile) return this.startUserProfile();
    if (!this.profileDir) throw new Error('沒有設定瀏覽器設定資料夾');
    fs.mkdirSync(this.profileDir, { recursive: true });
    const saved = this.readState();
    if (this.verifyEndpoint && !this.strictExecutable) this.bravePath = findBrave(this.bravePath, { fallback: !!this.fallbackBrowsers }).path;
    for (const port of [this.port, saved && saved.port].filter(Boolean)) {
      const version = await probeVersion(port);
      // A saved port may have been reassigned after the original browser exited.
      // Verify ownership before attaching OR closing a mode-mismatched browser.
      if (version && this.verifyEndpoint) {
        this.port = port; this.version = version;
        if (!await this.verifyEndpoint(this)) {
          this.port = 0; this.version = null;
          this.log('舊控制埠不屬於這個設定檔，改用新的控制埠。');
          continue;
        }
      }
      // 背景（無頭）與有視窗的 Brave 不能混用：模式不同就關掉舊的重開
      if (version && saved && port === saved.port && !!saved.noWindow !== this.noWindow) {
        try { const c = await new CdpConnection(version.webSocketDebuggerUrl, this.WebSocketImpl).open(); await c.send('Browser.close').catch(() => {}); c.close(); } catch { /* 已經關了 */ }
        await sleep(800);
        if (port === this.port) this.port = 0;
        continue;
      }
      if (version) { this.port = port; this.version = version; await this.attach(); this.log(`沿用已在執行的 Brave（除錯埠 ${port}）`); return this.info(); }
    }
    const found = this.strictExecutable ? {path:this.bravePath,tried:[this.bravePath]} : findBrave(this.bravePath, { fallback: !!this.fallbackBrowsers });
    if (!found.path) throw new Error(`找不到 Brave。已找過：${found.tried.join('、') || '（沒有可用路徑）'}。請在「API 設定 → 其他設定」指定 brave.exe 的位置。`);
    this.bravePath = found.path;
    const port = this.port || (await freePort());
    if(this.actionGuard && !this.actionGuard())throw Error('已停止');
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...(this.noWindow ? ['--headless=new', '--window-size=1366,900'] : []),
      ...(this.offscreen ? ['--window-position=-32000,-32000', '--window-size=800,600', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] : []),
      ...(this.hidden ? ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] : []),
      ...this.extraArgs,
      'about:blank',
    ];
    this.log(`啟動 Brave：${this.bravePath}（除錯埠 ${port}）`);
    const child = spawn(this.bravePath, args, { detached: true, stdio: 'ignore', windowsHide: this.noWindow || this.offscreen });
    child.unref();
    this.port = port;
    this.owned = true;
    const deadline = Date.now() + this.launchTimeoutMs;
    let version = null;
    while (!version && Date.now() < deadline) { version = await probeVersion(port); if (!version) await sleep(400); }
    if (!version) throw new Error('Brave 有啟動，但除錯埠一直沒有回應，請再試一次。');
    this.version = version;
    if(this.strictExecutable && this.verifyEndpoint && !await this.verifyEndpoint(this)){this.port=0;this.version=null;this.owned=false;throw Error('無法確認指定瀏覽器的執行檔、設定檔與本機控制埠，已停止連線。');}
    await this.attach();
    this.writeState();
    return this.info();
  }

  // 沿用使用者自己的 Brave：已經開著除錯埠就直接接上（不關它、不動它原本的分頁）；
  // 沒在跑就用同一個設定檔啟動；在跑但沒開除錯埠就講清楚，不擅自關掉使用者的瀏覽器。
  async startUserProfile() {
    const dir = userDataDir();
    this.profileDir = dir;
    const live = await userBravePort(dir);
    if (live) {
      this.port = live.port; this.version = live.version; this.owned = false;
      this.ownTabs = this.ownTabs || new Set();
      await this.attach();
      this.log(`接上你的 Brave（除錯埠 ${live.port}）`);
      return this.info();
    }
    if (profileInUse(dir)) {
      const err = new Error('你的 Brave 正在執行，但沒有開除錯埠，工作台接不上。請先把 Brave 全部關掉（工作台會用同一個設定檔、帶著你的登入重新開啟），或到「API 設定 → 其他設定」按「重新啟動我的 Brave」。');
      err.code = 'BRAVE_NO_DEBUG_PORT';
      throw err;
    }
    const found = findBrave(this.bravePath);
    if (!found.path) throw new Error(`找不到 Brave。已找過：${found.tried.join('、') || '（沒有可用路徑）'}。`);
    this.bravePath = found.path;
    const port = await freePort();
    const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--restore-last-session',
      ...(this.headless ? ['--headless=new', '--disable-gpu'] : []), ...this.extraArgs];
    this.log(`用你的設定檔啟動 Brave（除錯埠 ${port}）`);
    const child = spawn(this.bravePath, args, { detached: true, stdio: 'ignore', windowsHide: this.background });
    child.unref();
    this.port = port;
    // 這個 Brave 之後就是使用者自己的瀏覽器了：工作台停止時只關自己開的分頁，不關整個 Brave
    this.owned = false;
    this.ownTabs = this.ownTabs || new Set();
    const deadline = Date.now() + LAUNCH_TIMEOUT;
    let version = null;
    while (!version && Date.now() < deadline) { version = await probeVersion(port); if (!version) await sleep(400); }
    if (!version) throw new Error('Brave 有啟動，但除錯埠一直沒有回應。新版 Chromium 可能不允許在預設設定檔開除錯埠，請改用「App 內建瀏覽器」並按「從我的 Brave 匯入登入」。');
    this.version = version;
    await this.attach();
    if (this.background && !this.headless) await this.minimize();
    return this.info();
  }

  // 把工作台自己啟動的 Brave 視窗縮到最小，不擋使用者的畫面（使用者自己開著的視窗不動）
  async minimize() {
    try {
      const pages = await this.targets();
      if (!pages.length) return;
      const w = await this.conn.send('Browser.getWindowForTarget', { targetId: pages[0].targetId });
      if (w && w.windowId) await this.conn.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'minimized' } });
    } catch { /* 無頭模式或舊版沒有視窗可縮 */ }
  }

  // 開新分頁：背景開啟（不切換、不搶焦點），並記住是工作台開的
  async createTab(url) {
    // 無頭模式沒有視窗可搶；background 反而會讓頁面變成「看不見」而暫停動畫與計時器
    const created = await this.conn.send('Target.createTarget', { url, ...(this.background && !this.noWindow ? { background: true } : {}), ...(this.contextId ? { browserContextId: this.contextId } : {}) });
    if (this.ownTabs) this.ownTabs.add(created.targetId);
    this.allOwnTabs.add(created.targetId);
    return created.targetId;
  }

  async attach() {
    const conn = await new CdpConnection(this.version.webSocketDebuggerUrl, this.WebSocketImpl).open();
    conn.actionGuard=()=>!this.actionGuard||this.actionGuard();
    this.conn = conn;
    if (conn.ws && conn.ws.addEventListener) conn.ws.addEventListener('close', () => { if (this.conn === conn) { this.conn = null; this.sessions = new Map(); this.activeTab = null; this.version = null; } });
    this.conn.on('Target.detachedFromTarget', (params) => {
      if (!params || !params.sessionId) return;
      for (const [tabId, sessionId] of [...this.sessions]) if (sessionId === params.sessionId) this.sessions.delete(tabId);
    });
    await this.ensurePage();
    return this.info();
  }

  async targets() {
    const r = await this.conn.send('Target.getTargets');
    // 接在使用者自己的 Brave 上時，只看工作台開的分頁，絕不碰使用者原本的分頁
    return (r.targetInfos || []).filter((t) => t.type === 'page' && (!this.contextId || t.browserContextId === this.contextId) && (!this.ownTabs || this.ownTabs.has(t.targetId)));
  }

  async session(targetId) {
    const existing = this.sessions.get(targetId);
    if (existing) return existing;
    const r = await this.conn.send('Target.attachToTarget', { targetId, flatten: true });
    if (!r || !r.sessionId) throw new Error('無法附加到這個分頁');
    this.sessions.set(targetId, r.sessionId);
    // 無頭模式的瀏覽器身分會寫 HeadlessChrome，很多網站（包括 Google 登入）會擋；改報一般 Chrome
    if (this.noWindow && this.version) await this.conn.send('Emulation.setUserAgentOverride', headfulUA(this.version), r.sessionId).catch(() => {});
    return r.sessionId;
  }

  async ensurePage() {
    let pages = await this.targets();
    if (!pages.length) pages = [{ targetId: await this.createTab('about:blank') }];
    const first = pages[0].targetId;
    await this.session(first);
    if (!this.activeTab || !this.sessions.has(this.activeTab)) this.activeTab = first;
    return this.activeTab;
  }

  // tabId 省略時用目前的分頁
  async use(tabId) {
    if (!this.live) await this.start();
    if (tabId) {
      const pages = await this.targets();
      if (!pages.some((t) => t.targetId === tabId)) throw new Error(`找不到分頁 ${tabId}，請先用 browser_tabs 確認`);
      await this.session(tabId);
      this.activeTab = tabId;
      return tabId;
    }
    return this.ensurePage();
  }

  async evalRaw(expression, { tabId, userGesture = false } = {}) {
    const tab = await this.use(tabId);
    const sessionId = this.sessions.get(tab);
    const r = await this.conn.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false, userGesture }, sessionId);
    if (r.exceptionDetails) throw new Error(`頁面指令失敗：${(r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || '未知錯誤'}`);
    return r.result ? r.result.value : undefined;
  }

  async waitReady(tabId, timeoutMs = 20000, expectedUrl = '') {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { const state = await this.evalRaw('({ready:document.readyState,url:location.href})', { tabId }); if ((state.ready === 'complete' || state.ready === 'interactive') && (!expectedUrl || expectedUrl==='about:blank' || state.url!=='about:blank')) return true; } catch { /* 頁面還不能執行 */ }
      await sleep(250);
    }
    return false;
  }

  pageInfo(tabId) { return this.evalRaw('({ title: document.title, url: location.href })', { tabId }); }

  async tabs() {
    await this.use();
    const pages = await this.targets();
    return pages.map((t) => ({ tabId: t.targetId, title: t.title || '', url: t.url || '', active: t.targetId === this.activeTab }));
  }

  async open(input, { newTab = false } = {}) {
    const url = normalizeUrl(input);
    let tabId;
    if (newTab) {
      tabId = await this.createTab(url);
      await this.session(tabId);
    } else {
      tabId = await this.ensurePage();
      const sessionId = this.sessions.get(tabId);
      await this.conn.send('Page.enable', {}, sessionId);
      await this.conn.send('Page.navigate', { url }, sessionId);
    }
    this.activeTab = tabId;
    await this.waitReady(tabId, 25000, url);
    const info = (await this.pageInfo(tabId)) || {};
    return { tabId, url: info.url || url, title: info.title || '' };
  }

  async read({ tabId, maxChars = 6000 } = {}) {
    const value = await this.evalRaw('(function(){ return { title: document.title, url: location.href, text: document.body ? document.body.innerText : "" }; })()', { tabId });
    const text = String((value && value.text) || '').replace(/\n{3,}/g, '\n\n').trim();
    return { title: (value && value.title) || '', url: (value && value.url) || '', text: text.slice(0, maxChars), truncated: text.length > maxChars };
  }

  async snapshot({ tabId, max = 150 } = {}) {
    const value = await this.evalRaw(`${SNAPSHOT_SCRIPT}(${Number(max) || 150})`, { tabId });
    return value || { title: '', url: '', elements: [], text: '' };
  }

  async click({ tabId, index, selector, text } = {}) {
    const target = { index: index === undefined ? null : index, selector: selector || null, text: text || null };
    const box = await this.evalRaw(`${RESOLVE_SCRIPT}(${JSON.stringify(target)})`, { tabId, userGesture: true });
    if (!box || box.error) throw new Error((box && box.error) || '找不到可點擊的元素');
    const tab = await this.use(tabId);
    const sessionId = this.sessions.get(tab);
    await this.conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y }, sessionId);
    await this.conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 }, sessionId);
    await sleep(50);
    await this.conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 }, sessionId);
    await sleep(300);
    await this.waitReady(tab, 10000);
    const info = (await this.pageInfo(tab)) || {};
    return { desc: box.desc || box.tag, url: info.url || '', title: info.title || '' };
  }

  async type({ tabId, index, selector, text = '', submit = false } = {}) {
    if (index !== undefined || selector) {
      const target = { index: index === undefined ? null : index, selector: selector || null };
      const focused = await this.evalRaw(`${FOCUS_SCRIPT}(${JSON.stringify(target)})`, { tabId, userGesture: true });
      if (!focused || focused.error) throw new Error((focused && focused.error) || '找不到輸入框');
    }
    const tab = await this.use(tabId);
    const sessionId = this.sessions.get(tab);
    if (text) await this.conn.send('Input.insertText', { text: String(text) }, sessionId);
    if (submit) await this.pressKey('Enter', tab);
    return { ok: true, length: String(text).length, submitted: !!submit };
  }

  async pressKey(key, tabId) {
    const spec = keySpec(key);
    if (!spec) throw new Error(`不支援的按鍵：${key}`);
    const tab = await this.use(tabId);
    const sessionId = this.sessions.get(tab);
    const payload = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.windowsVirtualKeyCode, nativeVirtualKeyCode: spec.windowsVirtualKeyCode };
    await this.conn.send('Input.dispatchKeyEvent', { type: 'keyDown', ...payload, text: spec.key.length === 1 ? spec.key : undefined }, sessionId);
    await this.conn.send('Input.dispatchKeyEvent', { type: 'keyUp', ...payload }, sessionId);
    return { ok: true, key: spec.key };
  }

  async scroll({ tabId, deltaY = 600, deltaX = 0 } = {}) {
    const y = Number(deltaY) || 0;
    const x = Number(deltaX) || 0;
    const pos = await this.evalRaw(`(function(){ window.scrollBy(${x}, ${y}); return Math.round(window.scrollY); })()`, { tabId });
    return { ok: true, scrollY: pos };
  }

  async history({ tabId, direction = 'back' } = {}) {
    tabId = await this.use(tabId);
    const session = this.sessions.get(tabId);
    const history = await this.conn.send('Page.getNavigationHistory',{},session);
    const entry = history.entries[history.currentIndex + (direction === 'forward' ? 1 : -1)];
    if (entry) await this.conn.send('Page.navigateToHistoryEntry',{entryId:entry.id},session);
    await sleep(300);
    await this.waitReady(tabId, 15000);
    const info = (await this.pageInfo(tabId)) || {};
    return { url: info.url || '', title: info.title || '' };
  }

  async waitFor({ tabId, text, ms } = {}) {
    if (text) {
      const needle = JSON.stringify(String(text));
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const found = await this.evalRaw(`document.body ? document.body.innerText.includes(${needle}) : false`, { tabId });
        if (found) return { ok: true, found: true };
        await sleep(500);
      }
      return { ok: true, found: false };
    }
    const wait = Math.min(Math.max(Number(ms) || 1000, 0), 30000);
    await sleep(wait);
    return { ok: true, waited: wait };
  }

  async screenshot({ tabId, full = false } = {}) {
    const tab = await this.use(tabId);
    const sessionId = this.sessions.get(tab);
    await this.conn.send('Page.enable', {}, sessionId);
    const r = await this.conn.send('Page.captureScreenshot', full ? { format: 'png', captureBeyondViewport: true } : { format: 'png' }, sessionId);
    const buffer = Buffer.from((r && r.data) || '', 'base64');
    if (!buffer.length) throw new Error('截圖失敗（頁面沒有回傳畫面）');
    const dir = this.screenshotDir || path.dirname(this.stateFile || process.cwd());
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `brave-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
    await fsp.writeFile(file, buffer);
    return { path: file, bytes: buffer.length };
  }

  async closeTab({ tabId } = {}) {
    const tab = await this.use(tabId);
    if (tab === this.activeTab) this.activeTab = null;
    this.sessions.delete(tab);
    await this.conn.send('Target.closeTarget', { targetId: tab });
    if (this.ownTabs) this.ownTabs.delete(tab);
    this.allOwnTabs.delete(tab);
    for (let i=0;i<30 && (await this.targets()).some(t=>t.targetId===tab);i++) await sleep(100);
    return { ok: true };
  }

  async stop() {
    if (!this.live) { this.forgetConnection(); this.owned = false; return { ok: true, running: false }; }
    if (this.ownTabs && !this.owned) {
      // 使用者自己的 Brave：只關工作台開的分頁，瀏覽器本身留著
      for (const targetId of [...this.allOwnTabs]) { try { await this.conn.send('Target.closeTarget', { targetId }); } catch { /* 已經關了 */ } }
      this.allOwnTabs.clear(); this.ownTabs.clear();
    } else {
      try { await this.conn.send('Browser.close'); } catch { /* 已經關掉了 */ }
    }
    await sleep(500);
    this.forgetConnection(); // Browser.close 之後連線的 close 事件可能已經先把 conn 清掉了
    this.owned = false;
    return { ok: true, running: false };
  }
}

// 對外只需要這一層包裝：把工具指令轉成上面的操作，並序列化避免同時操作同一個分頁
function createController(opts = {}) {
  const browser = opts.shared || new BraveBrowser(opts);
  let scope = null;
  let activeGuard = null;
  const call = (fn) => { const guard=activeGuard; return browser.enqueue(async () => {
    if(guard && !guard())throw new Error('已停止');
    if (!opts.shared) {browser.actionGuard=guard;try{return await fn();}finally{browser.actionGuard=null;}}
    await browser.start();
    if (!scope || scope.conn !== browser.conn || !browser.live) {
      // 沿用登入：分頁要開在預設情境才拿得到使用者的 cookie；各對話改用「自己開過哪些分頁」區隔
      if (browser.userProfile) scope = { contextId:null, activeTab:null, sessions:new Map(), conn:browser.conn, ownTabs:new Set() };
      else {
        const r = await browser.conn.send('Target.createBrowserContext', { disposeOnDetach: true });
        scope = { contextId:r.browserContextId, activeTab:null, sessions:new Map(), conn:browser.conn, ownTabs:null };
        if (browser.prepareContext) { try { await browser.prepareContext(browser.conn, r.browserContextId); } catch (e) { browser.log(`帶入登入失敗：${e.message}`); } }
      }
    }
    const saved = { contextId:browser.contextId, activeTab:browser.activeTab, sessions:browser.sessions, ownTabs:browser.ownTabs };
    Object.assign(browser, { contextId:scope.contextId, activeTab:scope.activeTab, sessions:scope.sessions, ownTabs:scope.ownTabs });
    try { await browser.ensurePage(); if(guard && !guard())throw new Error('已停止'); return await fn(); }
    finally { scope.activeTab=browser.activeTab; Object.assign(browser,saved); }
  }); };
  return {
    browser,
    setGuard: guard => { activeGuard=guard; },
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

module.exports = { headfulUA, toCookieParam, BraveBrowser, CdpConnection, createController, findBrave, braveCandidates, normalizeUrl, probeVersion, freePort, userDataDir, userBravePort, profileInUse, keySpec, KEYS, SNAPSHOT_SCRIPT, RESOLVE_SCRIPT, FOCUS_SCRIPT };
