'use strict';
// GPT 網頁版使用工作台專用 Brave 設定檔，保留在登入視窗完成的登入。
// 送出時視窗放在螢幕外（不跳出來搶畫面）；需要人機驗證才移回螢幕。閒置後關閉以節省記憶體。
// 回覆以 DOM 變更喚醒讀取，最快每 100ms 一次；無變更則定期檢查。
// 此產品適配器與 Codex 操作使用者 Brave 的官方擴充工具是不同通道。
//
// 每段工作台對話對應一個 ChatGPT 對話（記住網址），接續時只送新的內容；
// 一次性呼叫（擴充代理、陪伴角色）用 ChatGPT 的「臨時對話」，不會塞進使用者的聊天紀錄，用完關掉分頁。
const path = require('path');
const fs = require('fs');
const { CdpConnection, BraveBrowser, toCookieParam, userBravePort, probeVersion } = require('./browserControl');
const { createWebTurnQueue } = require('./webTurnQueue');
const PAGE_DOM = require('./gptPageDom').script;

const HOME = 'https://chatgpt.com/';
const POLL_MS = Number(process.env.CODEX_MULTI_GPTWEB_POLL_MS) || 1500;
const READY_MS = 60000;
const MAX_TABS = 4;
const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener?.('abort', done); resolve(); }
  signal?.addEventListener?.('abort', done, { once: true });
});

// chatKey -> { targetId, usedAt }：工作台開過的分頁，只有這些會被重複使用或關閉
const tabs = new Map();
// 讀模型清單等短暫開出的分頁：送出時不要當成多餘分頁關掉
const transientTabs = new Set();
const privateBrowsers = new Map();
const privateStarts = new Map();
const ownedTabs = new Map();
let anonymousTabId = 0;
const webTurnQueue = createWebTurnQueue();

const IDLE_MS = Number(process.env.CODEX_MULTI_GPTWEB_IDLE_MS) || 30000;
let idleTimer = null;
let busyCount = 0;
const profileJobs = new Map();
const profileKey = dir => path.resolve(profileOf(dir)).toLowerCase();
function isProfileBusy(dir) {
  const key = profileKey(dir);
  const browser = privateBrowsers.get(key);
  const registry = browser && ownedTabs.get(browser.version.webSocketDebuggerUrl);
  return (profileJobs.get(key) || 0) > 0 || !!(registry && [...registry.values()].some(tab => tab.pinned));
}
async function closeProfile(dir) {
  if (isProfileBusy(dir)) throw new Error('這個 ChatGPT 帳號正在回覆或排隊，請等結束後再管理登入資料。');
  const key = profileKey(dir);
  if (privateStarts.has(key)) await privateStarts.get(key).catch(() => {});
  if (isProfileBusy(dir)) throw new Error('這個 ChatGPT 帳號正在回覆或排隊，請等結束後再管理登入資料。');
  const browser = privateBrowsers.get(key);
  privateBrowsers.delete(key);
  if (browser) { ownedTabs.delete(browser.version.webSocketDebuggerUrl); await browser.stop(); }
}
const profileOf = (profileDir) => profileDir || path.join(process.env.APPDATA || process.cwd(), 'Codex Multi', 'chatgpt-web-profile');
const loginMark = (profileDir) => path.join(profileOf(profileDir), 'chatgpt-login.json');
function loggedInBefore(profileDir) {
  try {
    const marker=JSON.parse(fs.readFileSync(loginMark(profileDir),'utf8'));
    // HTTP login markers never authenticated this browser profile.
    return !!marker && marker.transport!=='site-http';
  } catch { return false; }
}
function markLoggedIn(profileDir) { try { fs.mkdirSync(profileOf(profileDir), { recursive: true }); fs.writeFileSync(loginMark(profileDir), JSON.stringify({ at: Date.now() }), 'utf8'); } catch { /* 標記寫不進去只會多同步一次 */ } }
function clearLoginMark(profileDir) { try { fs.rmSync(loginMark(profileDir), { force: true }); } catch { /* 沒有就算了 */ } }
// 閒置一段時間就把獨立瀏覽器關掉，釋放記憶體與 CPU；下次送出時再啟動（登入狀態存在設定檔裡）
function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const retained = [...ownedTabs.values()].some(registry => [...registry.values()].some(tab => tab.pinned));
    if (!busyCount && !retained && hiddenRunning()) shutdown().catch(() => {});
    else if (retained) touchIdle();
  }, IDLE_MS);
  idleTimer.unref?.();
}
async function withBusy(fn, profileDir) {
  const key = profileKey(profileDir);
  profileJobs.set(key, (profileJobs.get(key) || 0) + 1);
  busyCount += 1;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  try { return await fn(); } finally { busyCount -= 1; const n = profileJobs.get(key) - 1; if (n) profileJobs.set(key, n); else profileJobs.delete(key); touchIdle(); }
}

async function hiddenBrave({ profileDir, bravePath = '', WebSocketImpl, importExistingLogin = true, showWindow = false } = {}) {
  const key = profileKey(profileDir);
  if (privateStarts.has(key)) return privateStarts.get(key);
  const live = privateBrowsers.get(key);
  if (live?.live) return { port: live.port, version: live.version, hidden: true };
  if (live) ownedTabs.delete(live.version.webSocketDebuggerUrl);
  const starting = (async () => {
    const base = profileOf(profileDir);
    const browser = new BraveBrowser({ profileDir: base, stateFile: path.join(base, 'browser-state.json'),
      bravePath, background: false, offscreen: !showWindow, launchTimeoutMs: 90000, WebSocketImpl, fallbackBrowsers: false,
      verifyEndpoint: require('./webTabCleanup').verifyReuse,
      extraArgs: ['--disable-extensions', '--mute-audio', '--disable-sync', '--disable-component-update', '--disable-default-apps', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=Translate,MediaRouter,CalculateNativeWinOcclusion'] });
    try {
      await browser.start();
      if(!await require('./webTabCleanup').cleanStartup(browser,['chatgpt.com'])){browser.forgetConnection();throw Error('無法確認工作台 ChatGPT 瀏覽器的設定檔與控制埠，已停止開啟新分頁。');}
      // 設定檔已經登入過就不必再向使用者的 Brave 同步 cookie（那一步要另外找程序、連線，很慢）。
      // 第一次（或登入失效後）才嘗試帶入；帶不到就請使用者按「登入 ChatGPT」在獨立視窗登入一次。
      if (importExistingLogin && !loggedInBefore(profileDir)) try {
        const { cookies } = await require('./braveLogin').readUserCookies({ liveOnly: true, bravePath, WebSocketImpl });
        const selected = cookies.filter(c => /(^|\.)(chatgpt\.com|openai\.com)$/.test(c.domain)).map(toCookieParam).filter(Boolean);
        if (selected.length) await browser.conn.send('Storage.setCookies', { cookies: selected });
      } catch { /* Keep the dedicated profile's previously saved ChatGPT login. */ }
      privateBrowsers.set(key, browser);
      return { port: browser.port, version: browser.version, hidden: true };
    } catch (error) {
      await browser.stop().catch(() => {});
      throw error;
    }
  })().finally(() => { privateStarts.delete(key); });
  privateStarts.set(key, starting);
  return starting;
}

async function shutdown() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  tabs.clear();
  transientTabs.clear();
  await Promise.allSettled([...privateStarts.values()]);
  const browsers = [...privateBrowsers.values()];
  privateBrowsers.clear();
  ownedTabs.clear();
  await Promise.allSettled(browsers.map(browser => browser.stop()));
}
function hiddenRunning() { return privateBrowsers.size > 0 || privateStarts.size > 0; }

function conversationUrl({ url, temporary }) {
  if (url && /^https:\/\/chatgpt\.com\/(?:g\/[^/]+\/)?c\//.test(url)) return url;
  const q = new URLSearchParams();
  if (temporary) q.set('temporary-chat', 'true');
  const s = q.toString();
  return s ? `${HOME}?${s}` : HOME;
}

async function findBrave() {
  const live = await userBravePort().catch(() => null);
  if (live) return live;
  const version = await probeVersion(9222).catch(() => null);
  if (version) return { port: 9222, version };
  const err = new Error('連不到你的 Brave：ChatGPT 網頁版要接在「開著除錯埠」的 Brave 上（沿用你已登入的 ChatGPT）。\n到「API 設定 → 其他設定 → 瀏覽器」按「重新啟動我的 Brave」（會保留原本的分頁），或切換左下方「Codex」。工作台不會自己另開一個 Brave。');
  err.code = 'NO_BRAVE';
  throw err;
}

// 在頁面裡執行的腳本：只取需要的那一小段，不動整頁
const PAGE = {
  state: `(() => {
    const q = (s) => document.querySelector(s);
    const { composer, scope, assistants, users, identity } = ${PAGE_DOM};
    // 沒登入時 ChatGPT 仍會給訪客輸入框，所以有「登入／註冊」鈕就算沒登入（不能只看有沒有輸入框）
    const login = !!(q('[data-testid="login-button"]') || q('[data-testid="signup-button"]') || (q('a[href*="/auth/login"]') && !composer)
      || [...document.querySelectorAll('button, a[role="button"]')].some(el => /^(?:登入|登錄|註冊|免費註冊|Log in|Sign in|Sign up)$/i.test((el.innerText || '').trim())
        && !el.closest('[hidden], [aria-hidden="true"]') && el.getClientRects().length > 0));
    const challenge = /just a moment|請稍候|verify you are human/i.test(document.title) || !!q('#challenge-form, iframe[src*="challenges.cloudflare"]');
    const stop = scope.querySelector('[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="停止"], button[aria-label*="中止"]');
    return { ready: document.readyState, url: location.href, composer: !!composer, login, challenge,
      busy: !!stop && !stop.closest('[hidden], [aria-hidden="true"]') && stop.getClientRects().length > 0,
      assistants: assistants.length, users: users.length,
      lastAssistantId: identity(assistants.at(-1)), lastUserId: identity(users.at(-1)),
      draft: composer ? (composer.innerText || composer.value || '').trim().length : 0 };
  })()`,
  insert: (text) => `(() => {
    const el = (${PAGE_DOM}).composer;
    if (!el) return -1;
    el.focus();
    if ('value' in el && el.tagName === 'TEXTAREA') {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const s = getSelection(); s.removeAllRanges();
      const r = document.createRange(); r.selectNodeContents(el); s.addRange(r);
      document.execCommand('insertText', false, ${JSON.stringify(text)});
    }
    return (el.innerText || el.value || '').trim().length;
  })()`,
  send: `(() => {
    const { scope } = ${PAGE_DOM};
    const b = scope.querySelector('[data-testid="send-button"], #composer-submit-button, button[aria-label*="Send"], button[aria-label*="傳送"], button[aria-label*="送出"], button[type="submit"]');
    if (!b) return 'missing';
    if (b.disabled || b.getAttribute('aria-disabled') === 'true') return 'disabled';
    b.click(); return 'clicked';
  })()`,
  stop: `(() => { const { scope } = ${PAGE_DOM}; const b = scope.querySelector('[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="停止"], button[aria-label*="中止"]'); if (b) { b.click(); return true; } return false; })()`,
  // 最後一則回答轉成 Markdown（程式碼區塊、清單、表格、數學式都保留），只看那一則
  last: `(() => {
    const { assistants: all, identity } = ${PAGE_DOM};
    const node = all[all.length - 1];
    if (!node) return { count: 0, text: '' };
    const root = node.querySelector('[data-markdown-text-style="assistant-message"]') || node.querySelector('.markdown, [class*="MarkdownRoot"]') || node;
    const esc = (s) => s.replace(/\\u00a0/g, ' ');
    const kids = (el, ctx) => Array.from(el.childNodes).map((c) => md(c, ctx)).join('');
    function md(n, ctx = {}) {
      if (n.nodeType === 3) return esc(n.nodeValue);
      if (n.nodeType !== 1) return '';
      const tag = n.tagName.toLowerCase();
      if (n.classList && n.classList.contains('katex')) { const a = n.querySelector('annotation[encoding="application/x-tex"]'); return a ? (n.closest('.katex-display') ? '\\n$$' + a.textContent + '$$\\n' : '$' + a.textContent + '$') : n.innerText; }
      if (['button', 'svg', 'style', 'script', 'nav'].includes(tag) || n.getAttribute('aria-hidden') === 'true' && tag !== 'span') return '';
      switch (tag) {
        case 'pre': { const code = n.querySelector('code'); const m = /language-([\\w+#-]+)/.exec(code ? code.className : ''); const head = n.querySelector('div.justify-between > div'); const lang = m ? m[1] : head ? head.innerText.trim().toLowerCase().replace(/\\s+/g, '') : ''; const body = (code || n).innerText.replace(/\\n$/, ''); return '\\n\`\`\`' + lang + '\\n' + body + '\\n\`\`\`\\n\\n'; }
        case 'code': return '\`' + n.innerText + '\`';
        case 'br': return '\\n';
        case 'hr': return '\\n---\\n\\n';
        case 'p': return kids(n, ctx).trim() + '\\n\\n';
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return '#'.repeat(+tag[1]) + ' ' + kids(n, ctx).trim() + '\\n\\n';
        case 'strong': case 'b': { const t = kids(n, ctx); return t.trim() ? '**' + t + '**' : t; }
        case 'em': case 'i': { const t = kids(n, ctx); return t.trim() ? '*' + t + '*' : t; }
        case 'del': case 's': return '~~' + kids(n, ctx) + '~~';
        case 'a': { const t = kids(n, ctx).trim(); const h = n.getAttribute('href') || ''; return h && !h.startsWith('#') ? '[' + (t || h) + '](' + h + ')' : t; }
        case 'blockquote': return kids(n, ctx).trim().split('\\n').map((l) => '> ' + l).join('\\n') + '\\n\\n';
        case 'ul': case 'ol': {
          const depth = (ctx.depth || 0);
          let i = Number(n.getAttribute('start') || 1);
          const items = Array.from(n.children).filter((c) => c.tagName === 'LI').map((li) => {
            const mark = tag === 'ol' ? (i++) + '. ' : '- ';
            const body = kids(li, { depth: depth + 1 }).trim().replace(/\\n{2,}/g, '\\n');
            return '  '.repeat(depth) + mark + body;
          });
          return (depth ? '\\n' : '') + items.join('\\n') + (depth ? '' : '\\n\\n');
        }
        case 'table': {
          const rows = Array.from(n.querySelectorAll('tr')).map((tr) => '| ' + Array.from(tr.children).map((c) => c.innerText.replace(/\\|/g, '\\\\|').replace(/\\n/g, ' ').trim()).join(' | ') + ' |');
          if (!rows.length) return '';
          const cols = (rows[0].match(/ \\| /g) || []).length + 1;
          rows.splice(1, 0, '|' + ' --- |'.repeat(cols));
          return rows.join('\\n') + '\\n\\n';
        }
        case 'img': { const alt = n.getAttribute('alt') || '圖片'; const src = n.getAttribute('src') || ''; return /^https?:/.test(src) ? '![' + alt + '](' + src + ')' : '[' + alt + ']'; }
        default: return kids(n, ctx);
      }
    }
    const text = md(root).replace(/\\n{3,}/g, '\\n\\n').trim();
    const err = node.querySelector('.text-token-text-error, [class*="text-red"]');
    const turn = node.closest('[data-talvt-turn-state]') || node.closest('article, [data-content-search-turn-key]') || node;
    const streamingSelector = '.result-streaming, [data-is-streaming="true"], [data-is-generating="true"]';
    const streaming = [turn, node, root].some(el => el.matches(streamingSelector)) || !!turn.querySelector(streamingSelector);
    const turnState = turn.getAttribute?.('data-talvt-turn-state');
    const actions = [...turn.querySelectorAll('[data-testid="copy-turn-action-button"], [data-testid="good-response-turn-action-button"], [data-testid="bad-response-turn-action-button"], [data-testid="regenerate-turn-action-button"], button[aria-label]')];
    const finished = turnState ? turnState === 'complete' : actions.some(el =>
      (/^(?:copy-turn-action-button|good-response-turn-action-button|bad-response-turn-action-button|regenerate-turn-action-button)$/.test(el.getAttribute?.('data-testid') || '')
        || /^(?:複製|重新產生回覆|Copy|Copy response|Regenerate response|Regenerate)$/i.test(el.getAttribute?.('aria-label') || ''))
      && !root.contains?.(el) && !el.disabled && !el.closest('[hidden], [aria-hidden="true"], pre, code') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
    return { count: all.length, id: identity(node), text, streaming, finished, model: node.getAttribute('data-message-model-slug') || node.querySelector('[data-message-model-slug]')?.getAttribute('data-message-model-slug') || '', error: err && !text ? err.innerText.slice(0, 300) : '' };
  })()`,
  model: `(() => { const b = document.querySelector('[data-testid="model-switcher-dropdown-button"],button[aria-label*="ChatGPT 模型"],button[aria-label*="ChatGPT model"]'); return b ? b.innerText.replace(/\\s+/g, ' ').trim().slice(0, 60) : ''; })()`,
  pageError: `(() => { const n = Array.from(document.querySelectorAll('[role="alert"], .text-token-text-error')).map((x) => x.innerText.trim()).filter(Boolean).pop(); return n ? n.slice(0, 300) : ''; })()`,
};

async function uploadImages(tab, images, signal, onStatus = () => {}, timeoutMs = 60000) {
  if (!images?.length) return true;
  for (const file of images) if (!path.isAbsolute(file) || !fs.statSync(file).isFile()) throw new Error('圖片檔案不存在，請重新附加。');
  const expression = `(() => { const el = (${PAGE_DOM}).composer; const scope = el && (el.closest('form') || el.closest('[data-testid="composer"]')); if (!scope) return {}; const input = scope.querySelector('input[type="file"][accept*="image"]') || scope.querySelector('input[type="file"]'); const error = [...scope.querySelectorAll('[role="alert"], .text-token-text-error')].map(n => n.innerText.trim()).filter(Boolean).pop() || ''; const pending = !!scope.querySelector('[role="progressbar"], [aria-busy="true"], [data-testid*="upload-progress"]'); const removals = scope.querySelectorAll('button[aria-label*="Remove file"], button[aria-label*="Remove image"], button[aria-label*="移除"]'); const count = removals.length || scope.querySelectorAll('[data-testid="attachment"]').length; const send = scope.querySelector('[data-testid="send-button"], #composer-submit-button, button[aria-label*="Send"], button[aria-label*="傳送"], button[aria-label*="送出"], button[type="submit"]'); return { ready: !!input, count, pending, error, sendReady: !!send && !send.disabled && send.getAttribute('aria-disabled') !== 'true' }; })()`;
  if (signal?.aborted) return false;
  const initial = await tab.eval(expression);
  if (signal?.aborted) return false;
  if (initial?.count) throw new Error('ChatGPT 輸入區有上次未送出的附件；請先清除再重試，避免重複上傳。');
  if (!initial?.ready) throw new Error('ChatGPT 網頁沒有可用的圖片上傳欄位；尚未送出訊息。請確認已登入且模型支援圖片。');
  const remote = await tab.conn.send('Runtime.evaluate', { expression: `(() => { const el = (${PAGE_DOM}).composer; const s = el && (el.closest('form') || el.closest('[data-testid="composer"]')); return s && (s.querySelector('input[type="file"][accept*="image"]') || s.querySelector('input[type="file"]')); })()`, returnByValue: false }, tab.sessionId);
  const objectId = remote.result?.objectId;
  if (!objectId) throw new Error('ChatGPT 圖片上傳欄位已改變，尚未送出訊息。');
  try { if (signal?.aborted) return false; await tab.conn.send('DOM.setFileInputFiles', { files: images, objectId }, tab.sessionId); }
  finally { await tab.conn.send('Runtime.releaseObject', { objectId }, tab.sessionId).catch(() => {}); }
  onStatus('正在上傳圖片，完成後才送出訊息…');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    const state = await tab.eval(expression);
    if (state?.error) throw new Error(`ChatGPT 圖片上傳失敗：${state.error}`);
    if (state?.count >= (initial.count || 0) + images.length && !state.pending && state.sendReady) return true;
    await sleep(300, signal);
  }
  throw new Error('ChatGPT 圖片上傳逾時，尚未送出訊息；請確認網頁附件狀態後重試。');
}

class Tab {
  constructor(conn, targetId) { this.conn = conn; this.targetId = targetId; this.sessionId = null; }
  async attach() {
    const r = await this.conn.send('Target.attachToTarget', { targetId: this.targetId, flatten: true });
    this.sessionId = r.sessionId;
    // 背景分頁不要被凍結、也當作有焦點，串流時畫面才會持續更新
    await this.conn.send('Page.enable', {}, this.sessionId).catch(() => {});
    await this.conn.send('Page.setWebLifecycleState', { state: 'active' }, this.sessionId).catch(() => {});
    await this.conn.send('Emulation.setFocusEmulationEnabled', { enabled: true }, this.sessionId).catch(() => {});
    return this;
  }
  async eval(expression) {
    const r = await this.conn.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, this.sessionId);
    if (r.exceptionDetails) throw new Error(`ChatGPT 頁面指令失敗：${(r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text}`);
    return r.result ? r.result.value : undefined;
  }
  replySnapshot() {
    const watch = require('./webReplyWatch');
    return this.eval(`(() => { const revision = ${watch.start}; return { revision, state: ${PAGE.state}, current: ${PAGE.last} }; })()`);
  }
  async waitForReplyChange(revision, timeoutMs, signal) {
    if (signal?.aborted) return;
    const watch = require('./webReplyWatch');
    const abort = () => { this.eval(watch.wake).catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try { await this.eval(watch.wait(revision, timeoutMs)); }
    finally { signal?.removeEventListener('abort', abort); }
  }
  stopReplyWatch() { return this.eval(require('./webReplyWatch').stop); }
  async present() {
    const window = await this.conn.send('Browser.getWindowForTarget', { targetId: this.targetId });
    if (window?.windowId) {
      if (window.bounds?.windowState !== 'normal') await this.conn.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { windowState: 'normal' } });
      // Old versions stored the dedicated window at -32000. Reusing its port or
      // profile must restore it; never reposition a normal user-placed window.
      if (window.bounds?.left <= -20000 || window.bounds?.top <= -20000) {
        const s = await this.eval('({left:screen.availLeft||0,top:screen.availTop||0,width:screen.availWidth,height:screen.availHeight})').catch(() => ({}));
        await this.conn.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: {
          left: (s.left || 0) + 40, top: (s.top || 0) + 40,
          width: Math.max(400, Math.min(1200, (s.width || 1280) - 80)),
          height: Math.max(300, Math.min(850, (s.height || 960) - 80)),
        } });
      }
    }
    await this.conn.send('Page.bringToFront', {}, this.sessionId);
  }
  // 專用視窗移到螢幕外：不跳出來，但仍是一般視窗（不最小化），頁面照常繪製與串流。
  async hide() {
    const window = await this.conn.send('Browser.getWindowForTarget', { targetId: this.targetId });
    if (!window?.windowId) return;
    if (window.bounds?.windowState !== 'normal') await this.conn.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { windowState: 'normal' } });
    if (window.bounds?.left > -20000) await this.conn.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { left: -32000, top: -32000, width: 1200, height: 850 } });
  }
  navigate(url) { return this.conn.send('Page.navigate', { url }, this.sessionId); }
}

// 新對話送出後 ChatGPT 會先給暫時 ID（/c/WEB:…），伺服器建立後才換成正式 ID；整段取到 / ? # 為止。
const chatIdOf = (u) => { const m = String(u || '').match(/\/c\/([^/?#]+)/); if (!m) return ''; try { return decodeURIComponent(m[1]); } catch { return m[1]; } };
const provisionalChatId = (id) => /^WEB[:_-]/i.test(String(id || ''));
// strict 用來決定要不要導頁（臨時對話與一般首頁不同）；等輸入框時只要求「同一段對話／不在別段對話」。
function sameChatUrl(cur, url, strict = true) {
  const want = chatIdOf(url);
  if (want) return chatIdOf(cur) === want;
  if (chatIdOf(cur) || !/^https:\/\/chatgpt\.com\//.test(cur || '')) return false;
  return !strict || /temporary-chat=true/.test(cur) === /temporary-chat=true/.test(url);
}

// 工作台專用的 Brave 只保留一個 ChatGPT 分頁：送出本來就一次一則，各對話輪流把同一分頁導到自己的網址。
// 其他頁面（舊版、閃退、閒置重開或 ChatGPT 連結開出的）一律關掉，避免分頁越積越多吃記憶體。
async function openSingleTab(conn, { chatKey, url, hidden = false }) {
  const infos = ((await conn.send('Target.getTargets')).targetInfos || []).filter((t) => t.type === 'page' && !transientTabs.has(t.targetId));
  const known = chatKey && tabs.get(chatKey);
  const keep = (known && infos.find((t) => t.targetId === known.targetId))
    || infos.find((t) => [...tabs.values()].some((v) => v.targetId === t.targetId))
    || infos.find((t) => /^https:\/\/chatgpt\.com\//.test(t.url || ''))
    || infos[0];
  for (const t of infos) if (t !== keep) await conn.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
  tabs.clear();
  let tab;
  if (keep) {
    tab = await new Tab(conn, keep.targetId).attach();
    if (!sameChatUrl(keep.url, url)) await tab.navigate(url);
  } else {
    const created = await conn.send('Target.createTarget', { url, background: !hidden });
    tab = await new Tab(conn, created.targetId).attach();
  }
  if (chatKey) tabs.set(chatKey, { targetId: tab.targetId, usedAt: Date.now() });
  return { tab, reused: !!keep };
}

// Each browser endpoint owns its registry. Never adopt, close or navigate a
// different chat's tab. A keepTab lease spans all MCP turns until closeSession.
function registryFor(brave) {
  const endpoint = brave.version.webSocketDebuggerUrl;
  if (!ownedTabs.has(endpoint)) ownedTabs.set(endpoint, new Map());
  return ownedTabs.get(endpoint);
}
async function openTab(conn, { chatKey, url, hidden = false, registry = tabs, keepTab = false }) {
  for (const [key, value] of registry) if (value.pendingClose) {
    if (!await closeTarget(conn,value.targetId)) throw Error('ChatGPT 上一輪分頁尚未回收，本次不會再建立新分頁。');
    registry.delete(key);
  }
  const known = chatKey && registry.get(chatKey);
  const infos = ((await conn.send('Target.getTargets')).targetInfos || []).filter(t => t.type === 'page');
  if (known && infos.some(t => t.targetId === known.targetId)) {
    known.usedAt = Date.now();
    known.pinned ||= keepTab;
    const tab = await new Tab(conn, known.targetId).attach();
    const current = infos.find(t => t.targetId === known.targetId).url || '';
    // A retained temporary/new chat may have acquired a formal route. Preserve
    // that exact tab across tool turns instead of returning it to the home page.
    if (!sameChatUrl(current, url) && !(known.pinned && !chatIdOf(url) && known.url === current)) await tab.navigate(url);
    return { tab, reused: true };
  }
  if (known?.pinned) throw new Error('這段 ChatGPT 工具對話的分頁已關閉；本輪不會另開新對話或重送訊息。');
  if (known) registry.delete(chatKey);
  // Preserve missing retained leases as tombstones: another chat must not
  // erase the evidence that this MCP continuation lost its original target.
  for (const [key, value] of registry) if (!value.pinned && !infos.some(t => t.targetId === value.targetId)) registry.delete(key);
  const idle = [...registry.entries()].filter(([,v]) => !v.pinned).sort((a,b) => a[1].usedAt - b[1].usedAt);
  while (registry.size >= MAX_TABS && idle.length) {
    const [key, value] = idle.shift();
    if(!await closeTarget(conn,value.targetId))throw Error('ChatGPT 舊分頁尚未回收，本次不會再建立新分頁。');
    registry.delete(key);
  }
  // Never discard another in-progress MCP conversation to satisfy the cap.
  if (registry.size >= MAX_TABS) throw new Error('ChatGPT 已有 4 段工具對話使用中，請等待其中一段完成後重試；現有對話會繼續。');
  const created = await conn.send('Target.createTarget', { url, background: !hidden });
  if (chatKey) registry.set(chatKey, { targetId: created.targetId, usedAt: Date.now(), pinned: keepTab, url });
  return { tab: await new Tab(conn, created.targetId).attach(), reused: false };
}

async function waitComposer(tab, signal, onStatus, url = '', guest = false) {
  const deadline = Date.now() + READY_MS;
  // 剛導頁時舊頁面可能還在回應；網址對上（或 10 秒後仍對不上，例如對話已刪而被導回首頁）才算就緒，
  // 避免把訊息打進舊頁、送出後又被判成「切換到另一段對話」。
  const settleBy = Date.now() + 10000;
  let told = false;
  while (Date.now() < deadline) {
    if (signal?.aborted) return null;
    let s = null;
    try { s = await tab.eval(PAGE.state); } catch { /* 頁面還在載入 */ }
    if (s) {
      if (guest && s.challenge) throw new Error('ChatGPT 訪客模式需要人機驗證；本輪停止，不會自動重送。');
      if (s.login && !(guest && require('./webGuest').composer('gpt',s))) { const e = new Error(guest ? 'ChatGPT 目前要求登入；訪客模式不可用，尚未送出。' : '工作台的 ChatGPT 網頁版還沒有登入。請到「API 設定」的 GPT「ChatGPT 網頁版」按「登入 ChatGPT」，在跳出的視窗登入一次就好（登入會保留，換電腦要重登一次）。'); e.code = 'LOGIN'; throw e; }
      if (s.challenge && !told) { told = true; await tab.present?.().catch(() => {}); onStatus('ChatGPT 正在做人機驗證，已把工作台的 Brave 視窗移到螢幕上；如果一直卡住，請在那個視窗手動點一下。'); }
      if (s.composer && !s.challenge && s.ready !== 'loading' && (!url || sameChatUrl(s.url, url, false) || Date.now() > settleBy)) return s;
    }
    await sleep(100, signal);
  }
  throw new Error('ChatGPT 頁面 60 秒內沒有出現輸入框（可能網路慢、ChatGPT 改版或被人機驗證擋住）。可以到 Brave 看一下工作台開的那個 ChatGPT 分頁。');
}

/**
 * 送出一則訊息並等回答完成。
 * opts: { chatKey, url, model, temporary, text, signal, onDelta, onStatus, timeoutMs, keepTab }
 * 回傳 { text, url, model, cancelled }
 */
async function ask(opts) {
  return withBusy(() => webTurnQueue.run(() => askInner(opts), {
    signal: opts.signal,
    onQueued: (ahead) => opts.onStatus?.(`ChatGPT 網頁版目前有其他對話正在回覆；這則已排隊，前面還有 ${ahead} 則。你可以切換到其他對話繼續操作。`),
  }), opts.profileDir);
}
// Completion must belong to the new assistant turn. A missing Stop button is
// insufficient: it can disappear between reasoning, tools and answer rendering.
async function collectReply({ tab, before, signal, onDelta = () => {}, onReplace = () => {}, timeoutMs = 30 * 60000,
  beforeId = '', initialUrl = '', requestedUrl = initialUrl, onStatus = () => {}, firstResponseMs = 90000,
  pollMs = POLL_MS, quietMs = 3000, now = Date.now, wait = sleep, guest = false }) {
  const started = now();
  const deadline = now() + timeoutMs;
  let text = '', state = {}, quietSince = null, rewritten = false, model = '';
  let lastStatusAt = started, expectedId = chatIdOf(initialUrl);
  // 從首頁開新對話：還沒收到回覆文字前，網址從首頁／暫時 ID 換成正式 ID 都是同一段對話。
  const requestedId = chatIdOf(requestedUrl);
  const fresh = !requestedId || provisionalChatId(requestedId);
  let observedAssistantId = '', observedUserId = '', promotedAfterText = false;
  try {
  while (true) {
    if (signal?.aborted) {
      await tab.eval(PAGE.stop).catch(() => {});
      return { text, state, rewritten, cancelled: true };
    }
    const sampledAt = now();
    const snapshot = tab.replySnapshot ? await tab.replySnapshot() : null;
    state = snapshot ? snapshot.state : await tab.eval(PAGE.state);
    const isNew = state.assistants > before || (beforeId && state.lastAssistantId && state.lastAssistantId !== beforeId);
    const current = isNew ? (snapshot ? snapshot.current : await tab.eval(PAGE.last)) : {};
    if (guest && state.challenge) throw new Error('ChatGPT 訪客模式需要人機驗證；已保留回應，不會自動重送。');
    if (state.login && !(guest && require('./webGuest').composer('gpt',state))) { const e = new Error('ChatGPT 要求登入；本次停止，不會自動重送。'); e.code = 'LOGIN'; throw e; }
    if (initialUrl && state.url && !/^https:\/\/chatgpt\.com\//.test(state.url)) throw new Error('ChatGPT 分頁已離開聊天網站；已收到的文字會保留。請回到原聊天分頁後再試。');
    // 比對對話 ID，不比整段網址（專案對話的 /g/…/c/ 前綴或查詢參數不同不算換對話）
    const id = chatIdOf(state.url);
    // A fresh conversation may receive its persistent route after tokens have
    // already arrived. URL similarity or matching text alone is not proof:
    // require the same exact assistant AND submitted-user message identities.
    // An existing conversation never gets this exception, nor a second remap.
    const sameTurn = !!(observedAssistantId && observedUserId
      && state.lastAssistantId === observedAssistantId && state.lastUserId === observedUserId);
    if (id) {
      if (expectedId && id !== expectedId && !provisionalChatId(expectedId)) {
        if (!(fresh && !text) && !(fresh && sameTurn && !promotedAfterText)) throw new Error('Brave 已切換到另一段 ChatGPT 對話；本次同步已停止，避免寫入別段對話。');
        if (text) promotedAfterText = true;
      }
      if (!expectedId || !provisionalChatId(id)) expectedId = id;
    } else if (state.url && expectedId && !(fresh && sameTurn)) {
      throw new Error('Brave 已離開原本的 ChatGPT 對話；本次同步已停止，已收到的文字會保留。');
    }
    if (!observedAssistantId && isNew && state.lastAssistantId && state.lastUserId) {
      observedAssistantId = state.lastAssistantId;
      observedUserId = state.lastUserId;
    }
    model = current.model || model;
    const body = String(current.text || '');
    if (body !== text && isNew) {
      if (body.startsWith(text)) onDelta(body.slice(text.length));
      else { onReplace(body); rewritten = true; }
      text = body;
      quietSince = null;
    }
    if (text && current.finished && !current.streaming && !state.busy) {
      if (quietSince === null) quietSince = now();
      if (now() - quietSince >= quietMs) return { text, state, model, rewritten, cancelled: false };
    } else quietSince = null;
    if (!state.busy && !body) {
      const error = current.error || await tab.eval(PAGE.pageError).catch(() => '');
      if (error) { const e = new Error(`ChatGPT 回報錯誤：${error}`); e.partial = text; e.url = state.url; throw e; }
    }
    if (now() >= deadline) {
      const e = new Error('ChatGPT 回覆尚未確認完成；已收到的內容已保留。');
      e.partial = text; e.url = state.url; throw e;
    }
    if (!text && !state.busy && now() - started >= firstResponseMs) throw new Error('訊息已送出，但 ChatGPT 網頁尚未顯示可讀回覆。請在可見的 Brave 確認登入、額度或網頁錯誤；這則不會自動重送。');
    if (now() - lastStatusAt >= 10000) {
      const stage = state.challenge ? '請在 Brave 完成人機驗證' : text ? '正在同步回覆，尚未確認完成' : state.busy ? 'ChatGPT 正在生成／思考' : '訊息已送出，等候網頁回覆';
      onStatus(`${stage} · ${Math.floor((now() - started) / 1000)} 秒`);
      lastStatusAt = now();
    }
    const remaining = Math.min(pollMs, deadline - now(), quietSince === null ? pollMs : quietMs - (now() - quietSince));
    if (snapshot && tab.waitForReplyChange) {
      await tab.waitForReplyChange(snapshot.revision, Math.max(1, remaining), signal);
      // Coalesce frequent DOM mutations; do not parse Markdown for every token.
      const throttle = Math.min(100, Math.max(1, remaining)) - (now() - sampledAt);
      if (throttle > 0) await wait(throttle, signal);
    } else await wait(Math.max(1, remaining), signal);
  }
  } catch (error) {
    if (error.partial == null) error.partial = text;
    if (!error.url) error.url = state.url;
    throw error;
  } finally { if (tab.stopReplyWatch) await tab.stopReplyWatch().catch(() => {}); }
}

async function askInner(opts) {
  if (opts.guest && (opts.model || opts.images?.length)) throw new Error('訪客模式只使用網站預設模型及文字訊息。');
  const { chatKey = '', text, signal, onDelta = () => {}, onStatus = () => {}, timeoutMs = 30 * 60000, temporary = false, WebSocketImpl } = opts;
  if (!String(text || '').trim() && !opts.images?.length) throw new Error('沒有訊息內容');
  onStatus('正在連接 Brave 的 ChatGPT 分頁；瀏覽器若已閒置關閉，會先重新啟動…');
  const session = opts.openSession ? await opts.openSession({ chatKey, url: conversationUrl({ url: opts.url, temporary }), temporary }) : null;
  // 每個瀏覽器連線各自記錄對話分頁，不借用其他對話的分頁。
  const brave = session || opts.brave || await hiddenBrave(opts);
  const conn = session?.conn || await new CdpConnection(brave.version.webSocketDebuggerUrl, WebSocketImpl).open();
  let tab = null;
  const registry = !session ? registryFor(brave) : null;
  const key = chatKey || `anonymous:${++anonymousTabId}`;
  try {
    const url = conversationUrl({ url: opts.url, temporary });
    onStatus('正在開啟工作台的 ChatGPT 分頁（隱藏視窗）…');
    // 工具橋接的臨時對話會連跑數輪：keepTab 時保留並用 chatKey 重接，最後由 closeSession 關掉。
    if (session) tab = session.tab;
    else ({ tab } = await openTab(conn, { chatKey: key, url, hidden: !!brave.hidden, registry, keepTab: !!opts.keepTab }));
    // Only the App-owned private browser is eligible for hiding. Supplied
    // embedded/user browser sessions retain their own visibility policy.
    if (brave.hidden && opts.hideWindow !== false) { if (tab.hide) await tab.hide().catch(() => {}); } else if (tab.present) await tab.present();
    let s;
    try { s = await waitComposer(tab, signal, onStatus, url, opts.guest); } catch (e) { if (e.code === 'LOGIN' && !opts.guest) clearLoginMark(opts.profileDir); throw e; }
    if (!s) return { text: '', cancelled: true };
    if (!opts.guest && !loggedInBefore(opts.profileDir)) markLoggedIn(opts.profileDir);
    // 上一則還在生成（例如使用者自己在這個分頁問了東西）：等它結束，不覆蓋
    for (let i = 0; s.busy && i < 40; i++) {
      if (i === 0) onStatus('這個 ChatGPT 對話還在回覆上一則，等它結束…');
      await sleep(POLL_MS, signal);
      if (signal?.aborted) return { text: '', cancelled: true };
      s = await tab.eval(PAGE.state);
    }
    if (s.busy) throw new Error('這個 ChatGPT 對話一直在生成上一則回答，這次沒有送出。');
    if (opts.model) {
      const selected = await tab.eval(PAGE.selectModel(opts.model));
      if (!selected) throw new Error(`ChatGPT 網頁沒有「${opts.model}」模型。請重新讀取模型選單，或選「沿用網頁上選的模型」。`);
    }
    if (opts.effort && opts.effort !== 'default') {
      await tab.eval(PAGE.selectEffort(opts.effort));
    }
    const before = s.assistants;
    const beforeId = s.lastAssistantId;
    const beforeUsers = s.users;
    const beforeUserId = s.lastUserId;
    const len = await tab.eval(PAGE.insert(String(text || '請分析附上的圖片。')));
    if (len < 0) throw new Error('找不到 ChatGPT 的輸入框');
    if (len === 0) {
      await conn.send('Input.insertText', { text: String(text || '請分析附上的圖片。') }, tab.sessionId);
    }
    if (!await uploadImages(tab, opts.images, signal, onStatus, opts.uploadTimeoutMs)) return { text: '', cancelled: true };
    onStatus(opts.images?.length ? '圖片已上傳，正在送出到 ChatGPT…' : '正在送出訊息到 ChatGPT…');
    let sent = false, sendState = '';
    for (let i = 0; i < 20 && !sent; i++) {
      if (signal?.aborted) return { text: '', cancelled: true };
      const r = await tab.eval(PAGE.send);
      sendState = r;
      if (r === 'clicked') sent = true;
      else await sleep(300, signal);
      if (signal?.aborted) return { text: '', cancelled: true };
    }
    if (!sent) {
      if (sendState === 'disabled') throw new Error('ChatGPT 送出按鈕仍停用，這則沒有送出。請在 Brave 確認輸入、附件與額度後重試。');
      // 找不到送出鈕：改按 Enter
      for (const type of ['keyDown', 'keyUp']) await conn.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, tab.sessionId);
    }
    // 確認真的送出去了
    const sentBy = Date.now() + 25000;
    while (true) {
      s = await tab.eval(PAGE.state);
      if (s.login && !(opts.guest && require('./webGuest').composer('gpt',s))) throw new Error('ChatGPT 要求登入；訊息尚未確認送出，不會自動重送。');
      if (s.users > beforeUsers || s.busy || s.assistants > before
        || (beforeUserId && s.lastUserId && beforeUserId !== s.lastUserId)
        || (beforeId && s.lastAssistantId && beforeId !== s.lastAssistantId)) break;
      if (Date.now() > sentBy) throw new Error('訊息沒有送出去：ChatGPT 的送出按鈕沒有反應。請稍後重試。');
      await sleep(100, signal);
      if (signal?.aborted) return { text: '', cancelled: true };
    }
    onStatus('ChatGPT 網頁版正在回覆…');
    const reply = await collectReply({ tab, before, beforeId, initialUrl: s.url, requestedUrl: url, signal, onDelta, onReplace: opts.onReplace, onStatus, timeoutMs, guest:opts.guest });
    s = reply.state;
    if (registry?.has(key) && s?.url) registry.get(key).url = s.url;
    if (reply.cancelled) return { text: reply.text, url: s?.url, cancelled: true };
    // The response has its own model metadata; do not reopen the entire picker
    // after a completed reply (it can wait 15 seconds on tool/fullscreen pages).
    const model = reply.model || opts.model || await tab.eval(PAGE.model).catch(() => '');
    // 還停在暫時 ID 就等正式網址出來，否則下一則接不回這段 ChatGPT 對話。
    for (let i = 0; i < 20 && provisionalChatId(chatIdOf(s?.url)); i++) {
      await sleep(250);
      s = await tab.eval(PAGE.state).catch(() => s);
    }
    if (registry?.has(key) && s?.url) registry.get(key).url = s.url;
    return { text: reply.text, url: provisionalChatId(chatIdOf(s?.url)) ? '' : s.url, model, cancelled: false, rewritten: reply.rewritten, targetId: tab.targetId };
  } catch (error) {
    if (error.code === 'LOGIN') clearLoginMark(opts.profileDir);
    throw error;
  } finally {
    // 一次性回覆只關自己的分頁；MCP 保留到整段工具流程結束。
    if ((tab || registry?.has(key)) && (temporary || opts.closeTab || !chatKey) && !opts.keepTab) {
      const item=registry?.get(key), targetId=tab?.targetId || item?.targetId;
      if(await closeTarget(conn,targetId))registry?.delete(key);
      else if(item){item.pendingClose=true;item.pinned=false;onStatus('網頁分頁回收尚未完成，已保留追蹤；不會繼續累積新分頁。');}
    }
    if (session) await session.release?.();
    else conn.close(); // 只斷開連線，Brave 本身不動
  }
}

/** 關閉工作台為某段 ChatGPT 對話開的背景分頁；只會碰 tabs 裡記錄的工作台分頁。 */
async function closeSession(chatKey, { WebSocketImpl, brave: given, profileDir, bravePath } = {}) {
  // Do not start a browser merely to close a session which no longer exists.
  const browser = privateBrowsers.get(profileKey(profileDir));
  const brave = given || (browser?.live ? { version: browser.version } : null);
  if (!brave) return false;
  const registry = ownedTabs.get(brave.version.webSocketDebuggerUrl);
  const known = chatKey && registry?.get(chatKey);
  if (!known) return false;
  let conn;
  try {conn=await new CdpConnection(brave.version.webSocketDebuggerUrl, WebSocketImpl || globalThis.WebSocket || require('ws')).open();const closed=await closeTarget(conn,known.targetId);if(closed && registry.get(chatKey)===known)registry.delete(chatKey);return closed;}
  finally {if(registry.get(chatKey)===known)known.pendingClose=true;known.pinned=false;conn?.close();touchIdle();}
}

async function closeTarget(conn,targetId){
  return require('./webTabCleanup').closeOwnedTarget(conn,targetId);
}

// Read the actual, visible model picker. Backend slugs may not be available in the web UI.
PAGE.models = require('./webPicker').script('models');
PAGE.selectModel = name => require('./webPicker').script('model', name);
PAGE.efforts = require('./webPicker').script('efforts');
PAGE.selectEffort = effort => require('./webPicker').script('effort', effort);

/** 讀 ChatGPT 帳號可用的模型：開一個背景分頁、不送訊息，讀完就關。回傳 { models: [{ slug, title, description }], defaultModel } */
async function listModels(o = {}) { return withBusy(() => webTurnQueue.run(() => listModelsInner(o), { signal: o.signal }), o.profileDir); }
async function listModelsInner({ WebSocketImpl, brave: given, signal, profileDir, bravePath, model, openSession, importExistingLogin = true, hideWindow = true } = {}) {
  const session = openSession ? await openSession({ chatKey: 'gptweb:models', url: HOME, temporary: true }) : null;
  const brave = session || given || await hiddenBrave({ WebSocketImpl, profileDir, bravePath, importExistingLogin });
  const conn = session?.conn || await new CdpConnection(brave.version.webSocketDebuggerUrl, WebSocketImpl).open();
  let tab = null;
  try {
    if (session) tab = session.tab;
    else {
      const created = await conn.send('Target.createTarget', { url: HOME, background: !brave.hidden });
      transientTabs.add(created.targetId);
      tab = await new Tab(conn, created.targetId).attach();
    }
    if (brave.hidden && hideWindow) await tab.hide?.().catch(() => {});
    else if (!hideWindow && brave.hidden) await tab.present?.();
    await waitComposer(tab, signal, () => {}, HOME);
    const r = await conn.send('Runtime.evaluate', { expression: PAGE.models, returnByValue: true, awaitPromise: true }, tab.sessionId);
    if (r.exceptionDetails) throw new Error(`讀不到 ChatGPT 的模型清單：${(r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text}`);
    const v = (r.result && r.result.value) || {};
    if (v.login) { const e = new Error('工作台的 ChatGPT 網頁版還沒有登入。請到「API 設定」按「登入 ChatGPT」登入一次後再試。'); e.code = 'LOGIN'; throw e; }
    if (!Array.isArray(v.models) || !v.models.length) throw new Error('ChatGPT 網頁模型選單沒有可讀的選項；請確認登入狀態後再試。');
    const seen = new Set();
    const models = v.models.filter((m) => m && m.slug && !seen.has(m.slug) && seen.add(m.slug)).map((m) => ({ slug: String(m.slug), title: String(m.title || m.slug).slice(0, 60), description: String(m.description || '').slice(0, 120) }));
    if (model) {
      if (!models.some(m => m.slug === model)) throw new Error(`ChatGPT 網頁沒有「${model}」模型，請重新讀取選單`);
      await tab.eval(PAGE.selectModel(model));
    }
    let effortInfo;
    try { effortInfo = await tab.eval(PAGE.efforts); } catch (e) { effortInfo = { efforts: [], effortError: e.message }; }
    // 只取推理強度欄位：不能讓讀推理選單的結果蓋掉上面已去重的模型清單
    const efforts = Array.isArray(effortInfo && effortInfo.efforts) ? effortInfo.efforts : [];
    return { models, defaultModel: String(v.defaultModel || ''), efforts, currentEffort: String((effortInfo && effortInfo.currentEffort) || ''), ...(effortInfo && effortInfo.effortError ? { effortError: effortInfo.effortError } : {}), effortModel: model || String(v.defaultModel || ''), pickerVersion: 2 };
  } finally {
    if (tab) await conn.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
    if (tab) transientTabs.delete(tab.targetId);
    if (session) await session.release?.();
    else conn.close();
  }
}

/** 設定頁用：檢查有沒有可用的瀏覽器、獨立設定檔是否登入過（不送出任何訊息、不啟動瀏覽器）。 */
async function status({ profileDir, bravePath = '' } = {}) {
  const found = findBrave2(bravePath);
  if (!found) return { ok: false, brave: false, loggedIn: false, message: '找不到 Brave、Edge 或 Chrome。請安裝其中一個，或在「API 設定 → 其他設定」指定瀏覽器位置。' };
  const name = /brave/i.test(found) ? 'Brave' : /msedge/i.test(found) ? 'Edge' : 'Chrome';
  if (!loggedInBefore(profileDir)) return { ok: false, brave: true, loggedIn: false, message: `尚未登入 ChatGPT。按右邊「登入 ChatGPT」，在跳出的 ${name} 視窗登入一次即可（換電腦要重登）。` };
  return { ok: true, brave: true, loggedIn: true, message: `已登入。各段對話使用自己的隱藏 ${name} 分頁，不會互相切走；同帳號的請求依序處理，閒置 ${Math.round(IDLE_MS / 60000)} 分鐘後清理以省資源。` };
}

function findBrave2(bravePath) { return require('./browserControl').findBrave(bravePath, { fallback: true }).path || ''; }

/**
 * 開一個看得見的獨立瀏覽器視窗（工作台專用的設定檔），讓使用者登入 ChatGPT。
 * 偵測到登入完成就自動關掉；登入狀態存在設定檔裡，之後背景送出直接沿用。
 */
async function login({ profileDir, bravePath = '', WebSocketImpl, signal, onStatus = () => {}, timeoutMs = 10 * 60000 } = {}) {
  await closeProfile(profileDir);
  const base = profileOf(profileDir);
  const browser = new BraveBrowser({ profileDir: base, stateFile: path.join(base, 'browser-state.json'),
    bravePath, background: false, offscreen: false, launchTimeoutMs: 90000, WebSocketImpl, fallbackBrowsers: true,
    verifyEndpoint: require('./webTabCleanup').verifyReuse });
  let conn = null;
  try {
    onStatus('開啟登入視窗…');
    await browser.start();
    conn = await new CdpConnection(browser.version.webSocketDebuggerUrl, WebSocketImpl).open();
    const created = await conn.send('Target.createTarget', { url: HOME, background: false });
    const tab = await new Tab(conn, created.targetId).attach();
    onStatus('請在跳出的視窗登入 ChatGPT，登入完成會自動關閉。');
    const deadline = Date.now() + timeoutMs;
    let okCount = 0;
    while (Date.now() < deadline) {
      if (signal?.aborted) return { ok: false, cancelled: true };
      let s = null;
      try { s = await tab.eval(PAGE.state); } catch { /* 頁面切換中 */ }
      if (s && s.composer && !s.login && !s.challenge && /chatgpt\.com/.test(s.url || '')) okCount += 1; else okCount = 0;
      if (okCount >= 3) { markLoggedIn(profileDir); await sleep(1500); return { ok: true }; }
      await sleep(1500, signal);
    }
    return { ok: false, timeout: true, message: '等了 10 分鐘還沒偵測到登入完成，視窗已關閉。' };
  } finally {
    try { conn?.close(); } catch { /* 已關閉 */ }
    await browser.stop().catch(() => {});
  }
}

module.exports = { collectReply, login, ask, closeSession, status, listModels, conversationUrl, findBrave, hiddenBrave, hiddenRunning, shutdown, isProfileBusy, closeProfile, uploadImages, PAGE, _Tab: Tab, _tabs: tabs, _webTurnQueue: webTurnQueue, _openSingleTab: openSingleTab, _openOwnedTab: openTab, _ownedTabs: ownedTabs, _registryFor: registryFor, _sameChatUrl: sameChatUrl, _chatIdOf: chatIdOf };
