'use strict';
const path = require('path');
const fs = require('fs');
const { BraveBrowser, CdpConnection } = require('./browserControl');
const { createWebTurnQueue } = require('./webTurnQueue');
const dom = require('./webModelsDom');
const watch = require('./webReplyWatch');
const IDLE_MS = 30000;
const NAVIGATION_RECOVERY_MS = 60000;
const pause = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
  const timer = setTimeout(finish, ms); signal?.addEventListener('abort', finish, { once: true });
});
function cancelled(text = '', url = '') { return { text, url, cancelled: true }; }
function failure(message, code = 'WEB_MODEL_ERROR') { const error = new Error(message); error.code = code; return error; }
async function closeTransientTarget(conn,targetId) {
  return require('./webTabCleanup').closeOwnedTarget(conn,targetId);
}
function isNavigationContextError(error) {
  return /cannot find (?:default execution context|context with specified id)|execution context (?:was destroyed|is not available)|cannot find execution context/i.test(String(error?.message || error));
}

// Every instance owns its browser profiles. It never attaches to the user's normal browser.
function create({ Browser = BraveBrowser, Connection = CdpConnection, now = Date.now, wait = pause, idleMs = IDLE_MS } = {}) {
  const profiles = new Map();
  const keyOf = profile => {
    if (!profile || typeof profile !== 'string' || !path.isAbsolute(profile)) throw failure('網頁模型需要 App 專用的登入設定檔');
    return path.resolve(profile).toLowerCase();
  };
  function entryFor(opts) {
    dom.siteInfo(opts.site);
    const key = keyOf(opts.profileDir);
    let entry = profiles.get(key);
    if (entry && entry.site !== opts.site) throw failure('不同網站不能共用同一個網頁帳號設定檔');
    if (!entry) {
      entry = { key, site: opts.site, profileDir: path.resolve(opts.profileDir), queue: createWebTurnQueue(), jobs: 0,
        tabs: new Map(), pendingClose:new Set(), browser: null, starting: null, timer: null, controllers: new Set(), closing: false, login: false };
      profiles.set(key, entry);
    }
    return entry;
  }
  function isBusy(profile) { const entry = profiles.get(keyOf(profile)); return !!entry && (entry.jobs > 0 || entry.login || [...entry.tabs.values()].some(tab=>tab.retained)); }
  async function close(entry) {
    clearTimeout(entry.timer); entry.timer = null; entry.closing = true;
    for (const controller of entry.controllers) controller.abort();
    if (entry.starting) await entry.starting.catch(() => {});
    const browser = entry.browser; entry.browser = null; entry.tabs.clear();
    if (browser) await browser.stop().catch(() => {});
    if (profiles.get(entry.key) === entry) profiles.delete(entry.key);
  }
  function idle(entry) {
    clearTimeout(entry.timer);
    if (entry.closing || entry.jobs || entry.login || [...entry.tabs.values()].some(tab=>tab.retained)) return;
    entry.timer = setTimeout(() => { if (!entry.jobs && !entry.login) close(entry).catch(() => {}); }, idleMs);
    entry.timer.unref?.();
  }
  async function browserFor(entry, opts, visible = false) {
    if (entry.closing) throw failure('網頁模型已停止', 'ABORT_ERR');
    if (entry.starting) await entry.starting;
    if (entry.browser?.live) return entry.browser;
    entry.starting = (async () => {
      const browser = new Browser({ profileDir: entry.profileDir, stateFile: path.join(entry.profileDir, 'web-browser-state.json'),
        bravePath: opts.bravePath || '', background: false, offscreen: !visible, fallbackBrowsers: false,
        WebSocketImpl: opts.WebSocketImpl || require('ws'), launchTimeoutMs: 60000,
        verifyEndpoint: require('./webTabCleanup').verifyReuse,
        extraArgs: ['--disable-extensions', '--disable-sync', '--disable-features=CalculateNativeWinOcclusion', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
      entry.browser = browser;
      try { await browser.start();const cleaned=await require('./webTabCleanup').cleanStartup(browser,[dom.siteInfo(entry.site).host]);if(browser.conn && !cleaned){browser.forgetConnection();throw failure('無法確認工作台瀏覽器的設定檔與控制埠，已停止開啟新分頁。');}return browser; }
      catch (error) { await browser.stop().catch(() => {}); if (entry.browser === browser) entry.browser = null; throw error; }
    })();
    try { return await entry.starting; } finally { entry.starting = null; }
  }
  async function session(entry, opts, visible = false) {
    const browser = await browserFor(entry, opts, visible);
    if (opts.signal?.aborted) throw failure('網頁操作已取消', 'ABORT_ERR');
    const conn = await new Connection(browser.version.webSocketDebuggerUrl, opts.WebSocketImpl || require('ws')).open();
    const chatKey = String(opts.chatKey || '__default__');
    let item = opts.transient ? null : entry.tabs.get(chatKey);
    try {
      if (opts.signal?.aborted) throw failure('網頁操作已取消', 'ABORT_ERR');
      const targets = ((await conn.send('Target.getTargets')).targetInfos || []).filter(t => t.type === 'page');
      for(const targetId of entry.pendingClose){
        if(targets.some(tab=>tab.targetId===targetId) && !await closeTransientTarget(conn,targetId))throw failure('暫時分頁尚未回收，本次不再建立新分頁。');
        entry.pendingClose.delete(targetId);
        for(const [key,tab] of entry.tabs)if(tab.targetId===targetId)entry.tabs.delete(key);
        if(item?.targetId===targetId)item=null;
      }
      for(const [key,tab] of entry.tabs)if(!tab.retained && !targets.some(target=>target.targetId===tab.targetId))entry.tabs.delete(key);
      if (item && !targets.some(t => t.targetId === item.targetId)) {
        entry.tabs.delete(chatKey);
        if(item.retained)throw failure('這段網頁工具對話的分頁已關閉；本次不會另開對話接續工具結果。');
        item = null;
      }
      if (!item) {
        // Evict only this subsystem's own idle tabs. Unrelated tabs are never closed.
        while (!opts.transient && entry.tabs.size >= 4) {
          const candidate = [...entry.tabs.entries()].find(([,item])=>!item.retained);
          if(!candidate)throw failure('這個網頁帳號的工具對話仍在使用；請等其中一段完成後再送出。');
          const [key, old] = candidate;
          if(!await closeTransientTarget(conn,old.targetId))throw failure('舊網頁分頁尚未完成回收；本次不會再開新分頁，請稍後重試。');
          entry.tabs.delete(key);
        }
        const target = await conn.send('Target.createTarget', { url: dom.siteInfo(opts.site).home, background: !visible && opts.hideWindow !== false });
        item = { targetId: target.targetId,retained:!!opts.keepTab };
        if (!opts.transient) entry.tabs.set(chatKey, item);
      } else { entry.tabs.delete(chatKey); entry.tabs.set(chatKey, item); }
      if (opts.signal?.aborted) throw failure('網頁操作已取消', 'ABORT_ERR');
      if(opts.keepTab)item.retained=true;
      const { sessionId } = await conn.send('Target.attachToTarget', { targetId: item.targetId, flatten: true });
      const evaluate = async expression => {
        const result = await conn.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sessionId);
        if (result.exceptionDetails) throw failure('網頁模型頁面讀取失敗；網站可能已改版。');
        return result.result?.value;
      };
      // A newly attached page can still be navigating (including Google's login
      // redirect). Only observations may be repeated: a lost execution context
      // after an action does not prove that action was never performed.
      const read = (expression, budget) => new Promise((resolve, reject) => {
        let timer, settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer); opts.signal?.removeEventListener('abort', aborted);
          if (error) reject(error); else resolve(value);
        };
        const aborted = () => finish(failure('網頁操作已取消', 'ABORT_ERR'));
        if (opts.signal?.aborted) return aborted();
        opts.signal?.addEventListener('abort', aborted, { once: true });
        timer = setTimeout(() => finish(failure('網頁正在切換，等待讀取逾時；不會自動重送訊息。', 'WEB_NAVIGATION_TIMEOUT')), Math.max(1, budget));
        evaluate(expression).then(value => finish(null, value), error => finish(error));
      });
      const observe = async (expression, valid = value => value !== undefined, phaseDeadline = Infinity) => {
        // Login/hydration and post-submit navigation can exceed five seconds.
        // Use the caller's stage deadline, with a separate bounded recovery window;
        // only these read-only expressions may run again after context destruction.
        const until = Math.min(opts.deadline || Infinity, phaseDeadline, now() + NAVIGATION_RECOVERY_MS);
        let reported = false;
        while (true) {
          if (opts.signal?.aborted) throw failure('網頁操作已取消', 'ABORT_ERR');
          if (now() >= until) throw failure('網頁正在切換，等待讀取逾時；不會自動重送訊息。', 'WEB_NAVIGATION_TIMEOUT');
          try {
            const state = await read(expression, until - now());
            if (valid(state)) return state;
            throw failure('Cannot find default execution context');
          } catch (error) {
            // A transport-timed-out evaluation is also safe to repeat here:
            // snapshots and editor verification have no side effects. Mutating
            // actions use evaluate() directly and never enter this retry loop.
            if (!isNavigationContextError(error) && error.message !== 'Runtime.evaluate 逾時') throw error;
            if (now() >= until) throw failure('網頁正在切換，等待讀取逾時；不會自動重送訊息。', 'WEB_NAVIGATION_TIMEOUT');
            if (!reported) { opts.onStatus?.('網頁正在切換，正在等待頁面恢復…'); reported = true; }
            await wait(Math.min(100, Math.max(1, until - now())), opts.signal);
          }
        }
      };
      const snapshot = phaseDeadline => observe(dom.script(entry.site), state => state && typeof state === 'object' && typeof state.url === 'string', phaseDeadline);
      await conn.send('Runtime.enable', {}, sessionId);
      await conn.send('Page.enable', {}, sessionId);
      await conn.send('Page.setWebLifecycleState', { state: 'active' }, sessionId).catch(() => {});
      await conn.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {});
      const show = async () => {
        const bounds = await conn.send('Browser.getWindowForTarget', { targetId: item.targetId });
        if (bounds.windowId) await conn.send('Browser.setWindowBounds', { windowId: bounds.windowId, bounds: { windowState: 'normal' } });
        if (bounds.windowId && (bounds.bounds?.left < -20000 || bounds.bounds?.top < -20000))
          await conn.send('Browser.setWindowBounds', { windowId: bounds.windowId, bounds: { left: 60, top: 60, width: 1200, height: 850 } });
        await conn.send('Page.bringToFront', {}, sessionId);
      };
      const hide = async () => {
        const window = await conn.send('Browser.getWindowForTarget', { targetId: item.targetId });
        if (!window.windowId) return;
        if (window.bounds?.windowState !== 'normal') await conn.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { windowState: 'normal' } });
        await conn.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { left: -32000, top: -32000, width: 1200, height: 850 } });
      };
      // These profiles and targets are exclusively owned by this subsystem.
      // Login always wins over the ordinary chat/discovery visibility choice.
      if (visible || opts.hideWindow === false) await show(); else await hide();
      return { conn, evaluate: expression => read(expression, Math.min(1000, (opts.deadline || Infinity) - now())), show, sessionId, item,
        snapshot,
        action: (action, value, phaseDeadline) => action === 'verifyInsert'
          ? observe(dom.script(entry.site, action, value), undefined, phaseDeadline)
          : action === 'listModels' ? read(dom.script(entry.site, action, value), Math.max(1,(phaseDeadline || opts.deadline || now()+5000)-now()))
          : evaluate(dom.script(entry.site, action, value)),
        release: () => conn.close(),
        closeTransient: async () => {if(!opts.transient)return;if(!await closeTransientTarget(conn,item.targetId))entry.pendingClose.add(item.targetId);},
        closeOwned: async () => {const closed=await closeTransientTarget(conn,item.targetId);if(closed && entry.tabs.get(chatKey)===item)entry.tabs.delete(chatKey);if(!closed)entry.pendingClose.add(item.targetId);return closed;},
      };
    } catch (error) {
      if ((opts.transient || opts.closeTab) && item) {const closed=await closeTransientTarget(conn,item.targetId);if(!closed)entry.pendingClose.add(item.targetId);if(closed && entry.tabs.get(chatKey)===item)entry.tabs.delete(chatKey);}
      conn.close(); throw error;
    }
  }
  function loginError(site, state, guest = false) {
    const title = dom.siteInfo(site).title;
    if (state.challenge) return failure(`${title} 需要人機驗證；請按登入，在顯示的視窗完成驗證後再送出。這則不會自動重送。`, 'WEB_CHALLENGE');
    if ((state.login && !(guest && require('./webGuest').composer(site,state))) || !dom.isSiteUrl(site, state.url)) return failure(`${title} ${guest ? '目前要求登入，訪客模式不可用' : '尚未登入或登入已失效'}；這則不會自動重送。`, 'WEB_LOGIN');
    return null;
  }
  async function composer(tab, opts, signal, deadline) {
    while (now() < deadline) {
      if (signal.aborted) return null;
      const state = await tab.snapshot(deadline);
      if (!state.url || state.url === 'about:blank') { await wait(100, signal); continue; }
      const error = loginError(opts.site, state, opts.guest);
      if (error) { if (error.code === 'WEB_CHALLENGE') await tab.show(); throw error; }
      if (state.composer && !state.busy) return state;
      opts.onStatus?.(state.busy ? `${dom.siteInfo(opts.site).title} 正在完成上一則回覆…` : '正在等待網頁輸入框…');
      await wait(100, signal);
    }
    throw failure('網頁在限定時間內沒有可用的輸入框；尚未送出。');
  }
  async function collect(tab, opts, before, signal, deadline) {
    let text = '', quietAt = null, model = '', lastStatus = now(), lastUrl = before.url;
    let expected = dom.conversationId(opts.site, before.url);
    let claimed = false;
    try {
      // The observer is only a best-effort wake-up hint. Navigation can remove
      // its context; polling below remains authoritative and must keep going.
      await tab.evaluate(watch.start).catch(error => { if (!isNavigationContextError(error) && error.code !== 'WEB_NAVIGATION_TIMEOUT') throw error; });
      while (now() < deadline) {
        if (signal.aborted) { tab.action('stop').catch(() => {}); return cancelled(text, lastUrl); }
        const state = await tab.snapshot(deadline);
        const authError = loginError(opts.site, state, opts.guest); if (authError) { if (authError.code === 'WEB_CHALLENGE') await tab.show(); throw authError; }
        const id = dom.conversationId(opts.site, state.url);
        if (expected && id !== expected) throw failure('網頁已切換到另一段對話；同步已停止，避免混入其他回覆。');
        if (!expected && id) expected = id;
        lastUrl = state.url;
        const newTurn = state.assistants > before.assistants || (state.lastAssistantId && state.lastAssistantId !== before.lastAssistantId)
          || ((state.users > before.users || state.lastUserId !== before.lastUserId) && state.current?.text !== before.current?.text);
        claimed ||= newTurn;
        if (claimed) {
          const next = String(state.current?.text || '');
          if (next !== text) { if (next.startsWith(text)) opts.onDelta?.(next.slice(text.length)); else opts.onReplace?.(next); text = next; quietAt = null; }
          model = state.model || model;
          if (text && state.current?.finished && !state.current.streaming && !state.busy) {
            if (quietAt === null) quietAt = now();
            if (now() - quietAt >= 2000) return { text, url: state.url, model, cancelled: false };
          } else quietAt = null;
        }
        if (state.error && !state.busy) throw failure(`${dom.siteInfo(opts.site).title}：${state.error}`);
        if (now() - lastStatus >= 10000) { opts.onStatus?.(text ? '正在同步網頁回覆，等待確認完成…' : '訊息已送出，正在等待網站回覆…'); lastStatus = now(); }
        await wait(100, signal);
      }
      tab.action('stop').catch(() => {});
      throw failure('網頁回覆逾時；已收到的內容已保留，不會自動重送。', 'WEB_TIMEOUT');
    } catch (error) {
      // Do not start a second recovery window while already handling a timeout.
      error.partial = text; error.url = lastUrl; throw error;
    }
    finally { await tab.evaluate(watch.stop).catch(() => {}); }
  }
  async function ask(opts) {
    if(opts.guest && (opts.site!=='gemini' || opts.model)) throw failure('訪客模式只使用 Gemini 網站預設模型。');
    dom.siteInfo(opts.site);
    if (opts.images?.length || opts.attachments?.length) throw failure('Claude／Gemini 網頁版目前只支援文字；附件尚未送出。', 'WEB_ATTACHMENTS_UNSUPPORTED');
    if (!String(opts.text || '').trim()) throw failure('沒有訊息內容');
    const entry = entryFor(opts);
    if (entry.login) throw failure('這個網頁帳號正在登入，請完成後再送出。');
    const controller = new AbortController(), abort = () => controller.abort();
    if (opts.signal?.aborted) controller.abort();
    opts.signal?.addEventListener('abort', abort, { once: true }); entry.controllers.add(controller);
    entry.jobs++; clearTimeout(entry.timer);
    try {
      return await entry.queue.run(async () => {
        if (controller.signal.aborted || entry.closing) return cancelled();
        let tab, submitted = false;
        try {
          const deadline = now() + Math.max(1000, Math.min(Number(opts.timeoutMs) || 30 * 60000, 60 * 60000));
          opts.onStatus?.(`正在連接 ${dom.siteInfo(opts.site).title} 網頁版…`);
          tab = await session(entry, { ...opts, signal: controller.signal, deadline });
          const before = await composer(tab, opts, controller.signal, Math.min(deadline, now() + 60000));
          if (!before || controller.signal.aborted) return cancelled();
          if (opts.model) {
            const selected = await tab.action('selectModel', String(opts.model));
            if (!selected?.ok) throw failure(`網站無法確認已選擇「${opts.model}」；請選沿用網頁模型，或在登入視窗先選好。尚未送出。`, 'WEB_MODEL_UNAVAILABLE');
          }
          if (controller.signal.aborted) return cancelled();
          await tab.action('insert', String(opts.text));
          // React/ProseMirror may replace the editor during hydration. Observe
          // the actual current editor settling, without inserting a second time.
          let inserted = false;
          const insertBy = Math.min(deadline, now() + 2000);
          while (!controller.signal.aborted && now() < insertBy) {
            if (await tab.action('verifyInsert', String(opts.text), insertBy)) { inserted = true; break; }
            await wait(100, controller.signal);
          }
          if (controller.signal.aborted) return cancelled();
          if (!inserted) throw failure('無法確認訊息已放入網站輸入框；尚未送出。');
          // Editors can accept text before their controlled send button enables.
          // Wait only through read-only checks; the actual click remains once.
          let sendReady = false;
          const readyBy = Math.min(deadline, now() + 3000);
          while (!controller.signal.aborted && now() < readyBy) {
            const preSend = await tab.snapshot(readyBy);
            const auth = loginError(opts.site, preSend, opts.guest); if (auth) throw auth;
            if (!await tab.action('verifyInsert', String(opts.text), readyBy)) throw failure('網站輸入框在送出前已變更；尚未送出，請重試。');
            if (preSend.sendReady !== false) { sendReady = true; break; }
            opts.onStatus?.('正在等待網站送出按鈕就緒…');
            await wait(100, controller.signal);
          }
          if (controller.signal.aborted) return cancelled();
          if (!sendReady) throw failure('網站送出按鈕尚未就緒；這則沒有送出，請稍後重試。', 'WEB_SEND_NOT_READY');
          if (now() >= deadline) throw failure('等待網頁輸入框逾時；尚未送出。', 'WEB_TIMEOUT');
          submitted = true;
          if (!await tab.action('send')) throw failure('網站送出按鈕無法使用；這則沒有送出。');
          let confirmed = false;
          const sentBy = Math.min(deadline, now() + 25000);
          while (now() < sentBy) {
            if (controller.signal.aborted) { await tab.action('stop').catch(() => {}); return cancelled(); }
            const state = await tab.snapshot(sentBy); const authError = loginError(opts.site, state, opts.guest); if (authError) { if (authError.code === 'WEB_CHALLENGE') await tab.show(); throw authError; }
            if (state.users > before.users || state.busy || state.lastUserId !== before.lastUserId || state.assistants > before.assistants || state.lastAssistantId !== before.lastAssistantId) { confirmed = true; break; }
            await wait(100, controller.signal);
          }
          if (!confirmed) throw failure('未能確認網站收到訊息；不會自動重送，請查看登入視窗。', 'WEB_SUBMIT_UNCONFIRMED');
          const result = await collect(tab, opts, before, controller.signal, deadline);
          return controller.signal.aborted ? cancelled(result.text, result.url) : result;
        } catch (error) {
          if (controller.signal.aborted) {
            // Aborted observations can bypass normal polling stop branches.
            // Dispatch once without blocking cancellation on the CDP reply.
            if (submitted) tab?.action('stop').catch(() => {});
            return cancelled(error.partial || '', error.url || '');
          }
          if (error.code === 'WEB_LOGIN') fs.rmSync(path.join(entry.profileDir, 'web-login.json'), { force: true });
          throw error;
        } finally {try{if(tab && opts.closeTab && !opts.keepTab && !await tab.closeOwned())opts.onStatus?.('網頁分頁回收尚未完成，已保留追蹤；不影響已收到的答案。');}finally{tab?.release();} }
      }, { signal: controller.signal, onQueued: ahead => opts.onStatus?.(`這個網頁帳號正在使用中，前面還有 ${ahead} 則；已排隊。`) });
    } finally {
      opts.signal?.removeEventListener('abort', abort); entry.controllers.delete(controller); entry.jobs--; idle(entry);
    }
  }
  async function listModels(opts) {
    dom.siteInfo(opts.site);
    const entry = entryFor(opts);
    if (entry.login) throw failure('這個網頁帳號正在登入，請完成後再讀取模型。');
    const controller = new AbortController(), abort = () => controller.abort();
    if (opts.signal?.aborted) controller.abort();
    opts.signal?.addEventListener('abort',abort,{once:true}); entry.controllers.add(controller);
    entry.jobs++; clearTimeout(entry.timer);
    let timeout;
    try {
      return await entry.queue.run(async()=>{
        if(controller.signal.aborted || entry.closing)return {models:[],cancelled:true};
        const deadline=now()+Math.max(1000,Math.min(Number(opts.timeoutMs)||60000,60000));
        let tab;
        timeout=setTimeout(()=>controller.abort(),Math.max(1000,Math.min(Number(opts.timeoutMs)||60000,60000)));
        try {
          opts.onStatus?.(`正在讀取 ${dom.siteInfo(opts.site).title} 網頁模型選單…`);
          tab=await new Promise((resolve,reject)=>{
            const aborted=()=>reject(failure('模型清單讀取已取消','ABORT_ERR'));
            controller.signal.addEventListener('abort',aborted,{once:true});
            session(entry,{...opts,signal:controller.signal,deadline,transient:true}).then(async opened=>{
              controller.signal.removeEventListener('abort',aborted);
              if(controller.signal.aborted){await opened.closeTransient();opened.release();return;}
              resolve(opened);
            },error=>{controller.signal.removeEventListener('abort',aborted);reject(error);});
          });
          const state=await composer(tab,opts,controller.signal,deadline);
          if(!state || controller.signal.aborted)return {models:[],cancelled:true};
          const found=await tab.action('listModels', '',deadline);
          if(controller.signal.aborted)return {models:[],cancelled:true};
          const seen=new Set();
          const models=(Array.isArray(found?.models)?found.models:[]).filter(model=>model && typeof model.title==='string' && model.title.trim() && model.title.length<=200 && !seen.has(model.title) && seen.add(model.title))
            .map(model=>({slug:model.title,title:model.title,description:String(model.description||'').slice(0,200)}));
            if(!models.length)throw failure(`${dom.siteInfo(opts.site).title} 網頁模型選單尚未就緒或網站結構已變更；請稍後重新讀取。`,'WEB_MODELS_UNAVAILABLE');
          return {models,defaultModel:models.some(model=>model.slug===found.defaultModel)?found.defaultModel:'',site:opts.site};
        } catch(error) {
          if(controller.signal.aborted)return {models:[],cancelled:true};
          throw error;
        } finally {
          clearTimeout(timeout);
          if(tab){await tab.closeTransient();tab.release();}
        }
      },{signal:controller.signal,onQueued:ahead=>opts.onStatus?.(`正在等候網頁帳號，前面還有 ${ahead} 則；讀取模型已排隊。`)});
    } finally {
      clearTimeout(timeout); opts.signal?.removeEventListener('abort',abort);entry.controllers.delete(controller);entry.jobs--;idle(entry);
    }
  }
  async function login(opts) {
    const entry = entryFor(opts);
    if (isBusy(opts.profileDir)) throw failure('這個網頁帳號正在回覆、排隊或登入；請稍後再登入。');
    entry.login = true; clearTimeout(entry.timer);
    const controller = new AbortController(), abort = () => controller.abort();
    if (opts.signal?.aborted) controller.abort(); opts.signal?.addEventListener('abort', abort, { once: true }); entry.controllers.add(controller);
    let tab;
    try {
      if (controller.signal.aborted) return { ok: false, cancelled: true };
      tab = await session(entry, { ...opts, signal: controller.signal, chatKey: '__login__' }, true);
      opts.onStatus?.(`請在顯示的 ${dom.siteInfo(opts.site).title} 視窗登入；完成後會保存這個帳號。`);
      const deadline = now() + Math.min(Number(opts.timeoutMs) || 10 * 60000, 10 * 60000);
      let ready = 0;
      while (now() < deadline) {
        if (controller.signal.aborted) return { ok: false, cancelled: true };
        const state = await tab.snapshot().catch(() => null);
        if (state && dom.isSiteUrl(opts.site, state.url) && state.composer && !state.login && !state.challenge) ready++; else ready = 0;
        if (ready >= 2) {
          fs.mkdirSync(entry.profileDir, { recursive: true });
          fs.writeFileSync(path.join(entry.profileDir, 'web-login.json'), JSON.stringify({ site: opts.site, at: now() }), 'utf8');
          return { ok: true, site: opts.site };
        }
        await wait(1000, controller.signal);
      }
      return { ok: false, timeout: true, message: '登入等待已逾時；請重新開啟登入。' };
    } finally {
      tab?.release(); opts.signal?.removeEventListener('abort', abort); entry.controllers.delete(controller); entry.login = false;
      // Visible login windows are App-owned and close after completion/cancel.
      await close(entry);
    }
  }
  async function status(opts) {
    dom.siteInfo(opts.site); keyOf(opts.profileDir);
    let loggedIn = false;
    try { const mark = JSON.parse(fs.readFileSync(path.join(opts.profileDir, 'web-login.json'), 'utf8')); loggedIn = mark.site === opts.site; } catch {}
    return { ok: loggedIn, loggedIn, busy: isBusy(opts.profileDir), site: opts.site,
      message: loggedIn ? '登入資料已保存；送出時會重新確認網站登入狀態。' : '尚未登入；請在連線選單開啟網站登入。' };
  }
  async function closeSession(chatKey, opts) {
    const entry=profiles.get(keyOf(opts.profileDir));
    const item=entry?.tabs.get(String(chatKey));
    if(item){
      let conn;
      try{conn=await new Connection(entry.browser.version.webSocketDebuggerUrl,opts.WebSocketImpl || require('ws')).open();if(await closeTransientTarget(conn,item.targetId) && entry.tabs.get(String(chatKey))===item)entry.tabs.delete(String(chatKey));}
      finally{if(entry.tabs.get(String(chatKey))===item)entry.pendingClose.add(item.targetId);conn?.close();item.retained=false;idle(entry);}
    }
  }
  async function shutdown() { await Promise.allSettled([...profiles.values()].map(close)); }
  return { ask, login, listModels, status, shutdown, closeSession, isBusy, hasRunning: () => profiles.size > 0 };
}
module.exports = { ...create(), create };
