'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { CdpConnection, freePort, normalizeUrl, SNAPSHOT_SCRIPT, RESOLVE_SCRIPT, FOCUS_SCRIPT } = require('./browserControl');
const { killTree } = require('./codexRunner');
const delay = ms => new Promise(r => setTimeout(r, ms));
const defaultPath = () => require('./wangpinBrowserPaths').resolveExecutable();
function decode(value) {
  if (!value || value.type === 'undefined') return undefined;
  if (value.type === 'null') return null;
  if (value.type === 'object') return Object.fromEntries((value.value || []).map(([k,v]) => [typeof k === 'string' ? k : decode(k), decode(v)]));
  if (value.type === 'array') return (value.value || []).map(decode);
  return value.value;
}
class FirefoxBrowser {
  constructor({ executable, profileDir, screenshotDir, headless = false, spawnImpl = spawn, connectionImpl = CdpConnection, portImpl = freePort, WebSocketImpl = require('ws'), reuseProfile = false, attachImpl = require('./firefoxAttach') } = {}) {
    this.executable = executable || defaultPath(); this.reuseProfile=reuseProfile;this.attachImpl=attachImpl;this.profileDir = profileDir || (reuseProfile ? attachImpl.defaultProfile(this.executable) : null); this.screenshotDir = screenshotDir;
    this.WebSocketImpl=WebSocketImpl;this.portImpl=portImpl;this.headless = headless; this.spawnImpl = spawnImpl; this.connectionImpl = connectionImpl;
    this.conn = null; this.child = null; this.starting = null; this.queue = Promise.resolve(); this.generation = 0;
  }
  info() { return { browser: '王品瀏覽器（Firefox）', path: this.executable, running: !!this.conn, profileDir: this.profileDir, reuseProfile:this.reuseProfile }; }
  async start() {
    if (this.conn?.ws?.readyState === 1) return this.info();
    if (this.starting) return this.starting;
    const generation=++this.generation;
    this.starting = (async()=>{if(this.child || this.conn){await this.closeOwned();await delay(300);}if(generation!==this.generation)throw Error('王品瀏覽器啟動已取消。');return this.launch(generation);})().finally(() => { this.starting = null; });
    return this.starting;
  }
  async launch(generation) {
    if(this.reuseProfile)return this.attach(generation);
    if (!fs.existsSync(this.executable)) throw Error('找不到王品 Firefox。請在使用權限選單選擇 firefox.exe。');
    if (!this.profileDir) throw Error('缺少王品瀏覽器專用設定檔資料夾。');
    fs.mkdirSync(this.profileDir, { recursive: true });
    // Only our dedicated profile: persist login, suppress session restoration/tab accumulation.
    fs.writeFileSync(path.join(this.profileDir, 'user.js'), ['user_pref("browser.startup.page", 0);','user_pref("browser.sessionstore.resume_from_crash", false);','user_pref("browser.sessionstore.resume_session_once", false);','user_pref("browser.shell.checkDefaultBrowser", false);'].join('\n'));
    const port = await this.portImpl();
    if(generation !== this.generation) throw Error('王品瀏覽器啟動已取消。');
    const args = ['-no-remote', '-new-instance', '-profile', this.profileDir, '--remote-debugging-port', String(port), '--remote-allow-hosts', 'localhost,127.0.0.1', 'about:blank'];
    if (this.headless) args.unshift('-headless');
    let failure = '', diagnostics = '', lastError = '';
    const child = this.spawnImpl(this.executable, args, { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    this.child = child;this.childClosed=new Promise(resolve=>{child.once('close',resolve);child.once('error',resolve);});
    child.once('error', e => { failure = e.message; });
    child.stderr?.on('data', d => { diagnostics = (diagnostics + d).slice(-2000); });
    child.stdout?.on('data', () => {});
    const end = Date.now() + 20000;
    while (Date.now() < end && generation === this.generation) {
      if (failure) break;
      const conn = new this.connectionImpl(`ws://127.0.0.1:${port}/session`,this.WebSocketImpl);
      try {
        await conn.open();
        await conn.send('session.new', { capabilities: {} });
        if (generation !== this.generation) { conn.close(); break; }
        this.conn = conn;this.initialContext=(await conn.send('browsingContext.getTree',{})).contexts?.[0]?.context || null;return this.info();
      } catch (e) { lastError=e.message;conn.close(); failure = child.exitCode ? `Firefox 結束（${child.exitCode}）：${diagnostics}` : ''; }
      await delay(150);
    }
    killTree(child); this.child = null;
    throw Error(generation !== this.generation ? '王品瀏覽器啟動已取消。' : `王品瀏覽器無法連線：${failure || lastError || diagnostics || '啟動逾時，專用設定檔可能已被另一個程序使用。'}`);
  }
  async attach(generation) {
    if(!fs.existsSync(this.executable))throw Error('找不到王品 Firefox，請選擇正確的執行檔。');
    const {nonce}=this.attachImpl.installBridge(this.executable);
    let data=this.attachImpl.descriptor(this.profileDir,this.executable,nonce);
    if(!data && await this.attachImpl.running(this.executable))throw Error('王品瀏覽器已開啟，但尚未啟用控制連線；請關閉後重新開啟王品瀏覽器一次。App 不會另外開新的設定檔。');
    if(generation!==this.generation)throw Error('王品瀏覽器啟動已取消');
    if(!data){
      // Ordinary launcher and existing profile: preserve sessions, logins and all user tabs.
      const child=this.spawnImpl(this.executable,['-profile',this.profileDir],{windowsHide:false,stdio:'ignore'});
      child.on('error',()=>{});child.unref?.();
      const end=Date.now()+20000;
      while(Date.now()<end&&generation===this.generation){await delay(150);data=this.attachImpl.descriptor(this.profileDir,this.executable,nonce);if(data)break;}
    }
    if(generation!==this.generation)throw Error('王品瀏覽器啟動已取消');
    if(!data)throw Error('王品瀏覽器控制尚未連線，請重新開啟王品瀏覽器後重試。');
    await this.attachImpl.verifyOwner(data,this.executable,this.profileDir);
    if(generation!==this.generation)throw Error("王品瀏覽器啟動已取消");
    // Bind the socket to IPv4 loopback while retaining Mozilla's allowed localhost Host.
    const Impl=this.WebSocketImpl;
    function LocalSocket(){return new Impl('ws://127.0.0.1:9222/session',{headers:{Host:'localhost:9222'}});}
    const conn=new this.connectionImpl(data.endpoint,LocalSocket);
    try{await conn.open();await conn.send('session.new',{capabilities:this.attachImpl.sessionCapabilities?.(data,this.profileDir)||{}});if(generation!==this.generation)throw Error('王品瀏覽器啟動已取消');this.conn=conn;return this.info();}
    catch(error){try{await conn.send('session.end',{});}catch{}conn.close();throw error;}
  }
  async stop() { ++this.generation;return this.closeOwned(); }
  async closeOwned() {
    const conn = this.conn; this.conn = null;
    if(this.reuseProfile){if(conn){try{await conn.send('session.end',{});}catch{}conn.close();}this.child=null;this.childClosed=null;return {running:false};}
    if (conn) { let timer;try { await Promise.race([conn.send('browser.close'),new Promise(resolve=>{timer=setTimeout(resolve,1200);})]); } catch { /* already closed */ }finally{clearTimeout(timer);conn.close();} }
    let exitTimer;if(this.childClosed){try{await Promise.race([this.childClosed,new Promise(resolve=>{exitTimer=setTimeout(resolve,2000);})]);}finally{clearTimeout(exitTimer);}}killTree(this.child);this.child=null;this.childClosed=null;return {running:false};
  }
  serialize(fn) { const result = this.queue.then(fn, fn); this.queue = result.catch(() => {}); return result; }
  async send(method, params) { this.actionGuard?.(); if (!this.conn) throw Error('王品瀏覽器連線中斷，請重新開啟。'); return this.conn.send(method, params); }
  async evaluate(context, expression) {
    const result = await this.send('script.evaluate', { expression, target: { context }, awaitPromise: true, resultOwnership: 'none', serializationOptions: { maxObjectDepth: 10 } });
    if (result.type === 'exception') throw Error(result.exceptionDetails?.text || 'Firefox 頁面指令失敗');
    return decode(result.result);
  }
  controller() {
    const own = new Set(); let active = null, connection = null, guard = null;
    const check = () => { if (guard && !guard()) throw Error('已停止'); };
    const invoke = fn => { const captured = guard; const valid = () => { if (captured && !captured()) throw Error('已停止'); }; return this.serialize(async () => {
      valid(); await this.start(); valid(); if (connection !== this.conn) { own.clear(); active = null; connection = this.conn; }
      this.actionGuard=valid;try{return await fn(valid);}finally{this.actionGuard=null;}
    }); };
    const tree = async () => (await this.send('browsingContext.getTree', {})).contexts || [];
    const context = async tabId => {
      const tabs = await tree(); for (const id of own) if (!tabs.some(t => t.context === id)) own.delete(id);
      if(this.reuseProfile){for(const tab of tabs)own.add(tab.context);if(!active&&tabs.length)active=tabs[0].context;}
      if (tabId && !own.has(tabId)) throw Error('這個分頁不屬於本段對話或已關閉，請重新讀取分頁清單。');
      if (tabId) active = tabId;
      if (!active || !own.has(active)) {
        if(this.initialContext && tabs.some(t=>t.context===this.initialContext)){active=this.initialContext;this.initialContext=null;}else{const created=await this.send('browsingContext.create',{type:'tab'});active=created.context;}own.add(active);
      }
      return active;
    };
    const read = async (id,max=6000) => this.evaluate(id, `(()=>{const text=document.body?.innerText||'';return {title:document.title,url:location.href,text:text.slice(0,${Math.max(1,Math.min(100000,Number(max)||6000))}),truncated:text.length>${Math.max(1,Math.min(100000,Number(max)||6000))}}})()`);
    const evalAt = async (args,expr) => this.evaluate(await context(args?.tabId),expr);
    const keyValues = { Enter:'\uE007', Tab:'\uE004', Escape:'\uE00C', Backspace:'\uE003', Delete:'\uE017', ArrowLeft:'\uE012',ArrowUp:'\uE013',ArrowRight:'\uE014',ArrowDown:'\uE015',PageUp:'\uE00E',PageDown:'\uE00F',Home:'\uE011',End:'\uE010',Space:' ' };
    const press = async (id,key) => {
      const value=keyValues[key] || (typeof key==='string' && Array.from(key).length===1 ? key : null);
      if (!value) throw Error('不支援的按鍵：'+key);
      await this.send('input.performActions',{context:id,actions:[{type:'key',id:'keyboard',actions:[{type:'keyDown',value},{type:'keyUp',value}]}]});
    };
    return {
      browser:this, setGuard:fn=>{guard=fn;}, info:()=>this.info(), start:()=>invoke(async()=>this.info()),stop:()=>this.stop(),
      tabs:()=>invoke(async()=>{const tabs=await tree();if(this.reuseProfile){for(const t of tabs)own.add(t.context);if(!active&&tabs.length)active=tabs[0].context;}return Promise.all(tabs.filter(t=>own.has(t.context)).map(async t=>({...await read(t.context,1),tabId:t.context,active:t.context===active})));}),
      open:args=>invoke(async valid=>{let id;if(args.newTab){id=(await this.send('browsingContext.create',{type:'tab'})).context;own.add(id);active=id;}else id=await context();valid();await this.send('browsingContext.navigate',{context:id,url:normalizeUrl(args.url),wait:'interactive'});return {...await read(id),tabId:id};}),
      read:args=>invoke(async()=>read(await context(args?.tabId),args?.maxChars)),
      snapshot:args=>invoke(async()=>evalAt(args,`${SNAPSHOT_SCRIPT}(150)`)),
      click:args=>invoke(async valid=>{const id=await context(args.tabId);const hit=await this.evaluate(id,`${RESOLVE_SCRIPT}(${JSON.stringify(args)})`);if(hit.error)throw Error(hit.error);valid();await this.send('input.performActions',{context:id,actions:[{type:'pointer',id:'mouse',parameters:{pointerType:'mouse'},actions:[{type:'pointerMove',x:hit.x,y:hit.y,origin:'viewport'},{type:'pointerDown',button:0},{type:'pointerUp',button:0}]}]});return {...await read(id),desc:hit.desc};}),
      type:args=>invoke(async valid=>{const id=await context(args.tabId);const focused=await this.evaluate(id,`${FOCUS_SCRIPT}(${JSON.stringify(args)})`);if(focused.error)throw Error(focused.error);valid();const chars=Array.from(String(args.text||''));for(let i=0;i<chars.length;i+=200){valid();await this.send('input.performActions',{context:id,actions:[{type:'key',id:'keyboard',actions:chars.slice(i,i+200).flatMap(value=>[{type:'keyDown',value},{type:'keyUp',value}])}]});}if(args.submit){valid();await press(id,'Enter');}return {length:String(args.text||'').length,submitted:!!args.submit};}),
      press:args=>invoke(async()=>press(await context(args.tabId),args.key)),
      scroll:args=>invoke(async()=>evalAt(args,`(()=>{window.scrollBy(${Number(args.deltaX)||0},${Number(args.deltaY)||600});return {scrollY:window.scrollY}})()`)),
      back:args=>invoke(async()=>{const id=await context(args?.tabId);await this.send('browsingContext.traverseHistory',{context:id,delta:-1});return read(id);}),
      forward:args=>invoke(async()=>{const id=await context(args?.tabId);await this.send('browsingContext.traverseHistory',{context:id,delta:1});return read(id);}),
      wait:args=>invoke(async valid=>{const id=await context(args.tabId);const ms=Math.max(0,Math.min(20000,Number(args.ms)||1000));if(!args.text){for(let left=ms;left>0;left-=100){valid();await delay(Math.min(100,left));}return {waited:ms};}const end=Date.now()+20000;while(Date.now()<end){valid();if((await read(id,100000)).text.includes(args.text))return {found:true};await delay(100);}return {found:false};}),
      screenshot:args=>invoke(async()=>{const id=await context(args?.tabId);const r=await this.send('browsingContext.captureScreenshot',{context:id,origin:args?.full?'document':'viewport',format:{type:'image/png'}});fs.mkdirSync(this.screenshotDir,{recursive:true});const file=path.join(this.screenshotDir,`firefox-${Date.now()}-${require('crypto').randomBytes(4).toString('hex')}.png`);const bytes=Buffer.from(r.data,'base64');fs.writeFileSync(file,bytes);return {path:file,bytes:bytes.length};}),
      closeTab:args=>invoke(async()=>{const id=await context(args?.tabId);await this.send('browsingContext.close',{context:id});own.delete(id);if(active===id)active=null;}),
      evalRaw:(expression,args)=>invoke(()=>evalAt(args,expression)),
    };
  }
}
module.exports={FirefoxBrowser,defaultPath,decode};
