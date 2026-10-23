'use strict';
// 把使用者電腦上 Brave 的登入狀態（cookie）帶進工作台。
// cookie 在磁碟上是加密的（新版還綁定 Brave 本身），自己解很容易壞；
// 所以一律讓 Brave 自己解：接上它的除錯埠，用 Storage.getCookies 讀出來。
const { spawn, execFile } = require('child_process');
const { CdpConnection, findBrave, probeVersion, freePort, userDataDir, userBravePort, profileInUse } = require('./browserControl');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cookiesFrom(wsUrl, WebSocketImpl) {
  const conn = await new CdpConnection(wsUrl, WebSocketImpl).open();
  try { return ((await conn.send('Storage.getCookies')) || {}).cookies || []; }
  finally { conn.close(); }
}

/**
 * 讀出使用者 Brave 的所有 cookie。
 * - Brave 開著除錯埠：直接讀，不影響使用者正在用的視窗
 * - Brave 沒在跑：用同一個設定檔在背景（無頭）開一下，讀完就關
 * - Brave 在跑但沒開除錯埠：讀不到，回報清楚的原因（不擅自關掉使用者的瀏覽器）
 */
async function readUserCookies({ bravePath = '', dir = userDataDir(), WebSocketImpl, liveOnly = false, signal } = {}) {
  const cancelled=()=>{if(signal?.aborted)throw Object.assign(new Error('已取消同步 Brave 登入。'),{name:'AbortError'});};
  cancelled();
  const live = await userBravePort(dir);
  cancelled();
  if (live) return { cookies: await cookiesFrom(live.version.webSocketDebuggerUrl, WebSocketImpl), via: `你正在用的 Brave（除錯埠 ${live.port}）` };
  // 自動同步只讀「開著除錯埠」的 Brave：在背景開使用者的設定檔時，使用者剛好點開 Brave 會接到那個無頭程序
  if (liveOnly) {
    const err = new Error(profileInUse(dir) ? '你的 Brave 正在執行，但沒有開除錯埠' : '你的 Brave 沒有在執行');
    err.code = profileInUse(dir) ? 'BRAVE_NO_DEBUG_PORT' : 'BRAVE_NOT_RUNNING';
    throw err;
  }
  if (profileInUse(dir)) {
    const err = new Error('你的 Brave 正在執行，但沒有開除錯埠，讀不到登入狀態。請先把 Brave 全部關掉再按一次，或按「重新啟動我的 Brave」。');
    err.code = 'BRAVE_NO_DEBUG_PORT';
    throw err;
  }
  const found = findBrave(bravePath);
  if (!found.path) throw new Error('找不到 Brave');
  const port = await freePort();
  const child = spawn(found.path, [`--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  try {
    let version = null;
    for (let i = 0; i < 60 && !version; i++) { cancelled(); version = await probeVersion(port); if (!version) await sleep(300); }
    cancelled();
    if (!version) throw new Error('Brave 在背景啟動後沒有回應，請再試一次');
    const cookies = await cookiesFrom(version.webSocketDebuggerUrl, WebSocketImpl);
    try { const c = await new CdpConnection(version.webSocketDebuggerUrl, WebSocketImpl).open(); c.send('Browser.close').catch(() => {}); setTimeout(() => c.close(), 300); } catch { /* 下面會強制結束 */ }
    return { cookies, via: '在背景用你的 Brave 設定檔讀取' };
  } finally {
    for (let i = 0; i < 20 && child.exitCode == null; i++) await sleep(150);
    if (child.exitCode == null) { try { child.kill(); } catch { /* 已經結束 */ } }
  }
}

const SAME_SITE = { Strict: 'strict', Lax: 'lax', None: 'no_restriction' };

/** CDP 的 cookie 轉成 Electron session.cookies.set 的格式 */
function toElectronCookie(c) {
  const host = String(c.domain || '').replace(/^\./, '');
  if (!host || !c.name) return null;
  const details = {
    url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
    name: c.name,
    value: c.value == null ? '' : String(c.value),
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
  };
  // 開頭有點的是網域 cookie；沒有點的是只給這個主機的 cookie（__Host- 開頭也必須這樣）
  if (String(c.domain).startsWith('.') && !String(c.name).startsWith('__Host-')) details.domain = c.domain;
  if (!c.session && Number(c.expires) > 0) details.expirationDate = Number(c.expires);
  if (SAME_SITE[c.sameSite]) details.sameSite = SAME_SITE[c.sameSite];
  if (details.sameSite === 'no_restriction' && !details.secure) delete details.sameSite; // 瀏覽器不接受不安全的 SameSite=None
  return details;
}

async function importInto(ses, cookies) {
  let ok = 0; let failed = 0; const sites = new Set();
  for (const c of cookies) {
    const d = toElectronCookie(c);
    if (!d) { failed++; continue; }
    try { await ses.cookies.set(d); ok++; sites.add(d.url.split('/')[2].split('.').slice(-2).join('.')); } catch { failed++; }
  }
  try { await ses.cookies.flushStore(); } catch { /* 下次關閉時也會寫入 */ }
  return { ok, failed, sites: sites.size };
}

/**
 * 重新啟動使用者的 Brave 並開啟除錯埠（使用者按按鈕才會做）。
 * 先正常關閉（讓 Brave 自己存好分頁），再用 --restore-last-session 帶回原本的分頁。
 */
async function restartUserBrave({ bravePath = '', port = 9222, dir = userDataDir() } = {}) {
  const live = await userBravePort(dir);
  if (live) return { ok: true, port: live.port, already: true };
  const found = findBrave(bravePath);
  if (!found.path) throw new Error('找不到 Brave');
  if (profileInUse(dir)) {
    await new Promise((resolve) => execFile('taskkill', ['/IM', 'brave.exe'], { windowsHide: true }, () => resolve()));
    for (let i = 0; i < 50 && profileInUse(dir); i++) await sleep(300);
    if (profileInUse(dir)) throw new Error('Brave 沒有在 15 秒內關閉（可能有「確定要離開嗎」的對話框），請手動關閉後再試');
  }
  const child = spawn(found.path, [`--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--restore-last-session', '--no-first-run', '--no-default-browser-check'], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 60; i++) { if (await probeVersion(port)) return { ok: true, port }; await sleep(400); }
  throw new Error('Brave 重新開啟了，但除錯埠沒有回應');
}

/**
 * 內建瀏覽器對外顯示的瀏覽器識別：拿掉 Electron 與 App 名稱，看起來就是一般的 Chrome／Brave。
 * Google 登入頁看到 Electron 會拒絕（「這個瀏覽器可能不安全」），YouTube 也會把匯入的登入當成沒登入。
 */
function chromeLikeUA(ua) {
  return String(ua || '').replace(/\s+codex-?multi\/\S+/gi, '').replace(/\s+Electron\/\S+/gi, '').replace(/\s{2,}/g, ' ').trim();
}

module.exports = { readUserCookies, toElectronCookie, importInto, restartUserBrave, chromeLikeUA };
