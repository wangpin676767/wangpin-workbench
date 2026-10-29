'use strict';
const crypto=require('node:crypto');
const {ORIGINS}=require('./websiteHttp');
const patched=new WeakSet();
function createManager(injected){
 const electron=injected||require('electron');
 function getSession({site,accountId='default'}){
  if(!ORIGINS[site]||typeof accountId!=='string'||accountId.length>1000)throw new Error('Invalid website account scope');
  const key=crypto.createHash('sha256').update(site+'\0'+accountId).digest('hex');
  const jar=electron.session.fromPartition('persist:website-http-'+key,{cache:false});
  // Sites (Cloudflare, Google sign-in) reject the default Electron/app user agent, so login "succeeds" in the window but never yields a session.
  if(!patched.has(jar)){patched.add(jar);try{jar.setUserAgent(require('./braveLogin').chromeLikeUA(jar.getUserAgent()));}catch{}}
  return jar;
 }
 async function getCookies(options){
  const domain=options.site==='gemini'?'google.com':options.site==='claude'?'claude.ai':'chatgpt.com';
  const jar=getSession(options),cookies=await jar.cookies.get({});
  return cookies.filter(cookie=>{const host=String(cookie.domain||'').replace(/^\./,'').toLowerCase();return host===domain||host.endsWith('.'+domain);});
 }
 async function login({site,accountId='default',signal,timeoutMs=300000,verify}={}){
  if(!ORIGINS[site])throw new Error('Invalid website');if(signal?.aborted)throw Object.assign(new Error('已取消登入。'),{name:'AbortError'});
  const session=getSession({site,accountId});
  const window=new electron.BrowserWindow({width:1100,height:800,show:true,title:'網站帳號登入',webPreferences:{session,nodeIntegration:false,contextIsolation:true,sandbox:true}});
  const contents=window.webContents;
  contents.setWindowOpenHandler?.(({url})=>{try{const target=new URL(url);if(target.protocol==='https:'&&(target.hostname.endsWith('.google.com')||['accounts.google.com','auth.openai.com','auth0.openai.com','chatgpt.com','claude.ai','appleid.apple.com','login.microsoftonline.com'].includes(target.hostname)))contents.loadURL(url).catch(()=>{});}catch{}return {action:'deny'};});
  let closed=false,checking=false,timer,poll,settled=false;
  return new Promise((resolve,reject)=>{
   const done=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);clearInterval(poll);signal?.removeEventListener('abort',cancel);window.removeListener('closed',onClose);if(!closed&&!window.isDestroyed())window.close();if(error)reject(error);else resolve(value);};
   const cancel=()=>done(Object.assign(new Error('已取消網站登入。'),{name:'AbortError'}));
   const onClose=()=>{closed=true;done(Object.assign(new Error('登入視窗已關閉；尚未確認登入完成。'),{name:'AbortError'}));};
   window.once('closed',onClose);signal?.addEventListener('abort',cancel,{once:true});
   const check=async()=>{if(checking||settled)return;checking=true;try{const result=verify?await verify(session):await require('./websiteHttp').create({site,fetch:session.fetch.bind(session),timeoutMs:10000,signal}).status();if(result?.ok||result?.loggedIn){await session.cookies.flushStore?.();done(null,{ok:true,loggedIn:true,site,transport:'site-http'});}}catch{}finally{checking=false;}};
   timer=setTimeout(()=>done(new Error('網站登入等待逾時；請重新開啟登入並完成網站驗證。')),Math.min(Math.max(timeoutMs,1000),600000));
   poll=setInterval(check,2000);timer.unref?.();poll.unref?.();
   window.loadURL(ORIGINS[site]+(site==='gemini'?'/app':'/')).then(check).catch(()=>done(new Error('無法開啟網站登入頁。')));
  });
 }
 const DOMAINS={gpt:['chatgpt.com','openai.com'],claude:['claude.ai','anthropic.com'],gemini:['google.com']};
 // 沿用使用者 Brave 已登入的 cookie（只匯入該網站網域；cookie 不寫入紀錄）
 async function syncFromBrave({site,accountId='default',readCookies,bravePath='',signal}={}){
  if(!DOMAINS[site])throw new Error('Invalid website');
  const read=readCookies||(opts=>require('./braveLogin').readUserCookies(opts));
  const {cookies,via}=await read({bravePath,signal});
  const cancelled=()=>{if(signal?.aborted)throw Object.assign(new Error('已取消登入。'),{name:'AbortError'});};
  cancelled();
  const wanted=(cookies||[]).filter(c=>{const host=String(c.domain||'').replace(/^\./,'').toLowerCase();return DOMAINS[site].some(d=>host===d||host.endsWith('.'+d));});
  if(!wanted.length)return {ok:false,imported:0,via,message:'Brave 裡沒有這個網站的登入 cookie'};
  const jar=getSession({site,accountId});
  await jar.clearStorageData({storages:['cookies']});
  cancelled();
  const result=await require('./braveLogin').importInto(jar,wanted);
  if(result.failed||signal?.aborted){await jar.clearStorageData({storages:['cookies']});cancelled();throw new Error('部分 Brave 登入資料無法同步，已清除不完整的登入，請重試。');}
  return {ok:result.ok>0,imported:result.ok,failed:result.failed,via};
 }
 async function clearSession(options){await getSession(options).clearStorageData({storages:['cookies','localstorage','indexdb','cachestorage']});}
 async function syncFromWangpin(options={}){
  return syncFromBrave({...options,readCookies:options.readCookies||(()=>require('./wangpinLogin').readCookies(options))}).then(r=>({...r,message:r.ok?undefined:'王品瀏覽器沒有此網站的登入資料；請先登入後重試。'}));
 }
 return {getSession,getCookies,login,syncFromBrave,syncFromWangpin,clearSession};
}
let manager;
const current=()=>manager||(manager=createManager());
module.exports={createManager,getSession:options=>current().getSession(options),getCookies:options=>current().getCookies(options),login:options=>current().login(options),syncFromBrave:options=>current().syncFromBrave(options)};
