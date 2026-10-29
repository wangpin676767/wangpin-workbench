'use strict';
// Browser identity is selected by conversation, never supplied as a path/command.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const IDS = ['wangpin', 'brave', 'chrome', 'edge', 'firefox', 'app'];
const LABELS = {wangpin:'王品瀏覽器（Firefox）',brave:'Brave',chrome:'Google Chrome',edge:'Microsoft Edge',firefox:'Firefox',app:'App 內建瀏覽器'};
// Only bind an unambiguous request to use Wangpin; merely mentioning or
// comparing browsers does not authorize a choice. Continuations may refer
// back to the most recent explicit user request when no selection exists.
function explicitWangpin(text) {
  const lines=String(text||'').split(/[。！？!?\n]/);
  for(let i=lines.length-1;i>=0;i--){
    const line=lines[i];
    if(!/王品\s*(?:瀏覽器|browser)/i.test(line))continue;
    if(/(?:不要|別用|不使用|不用|不能用|不可用|無法用|無法操作|不能操作|沒有操作|沒操作|未操作|未連|沒連|沒有打開|沒有開啟|沒打開|沒開啟).{0,8}王品\s*(?:瀏覽器|browser)|王品\s*(?:瀏覽器|browser).{0,8}(?:不能用|不可用|未連線|沒連線|沒有打開|沒打開)/i.test(line))return null;
    if(/(?:在|用|使用|操作|打開|開啟|透過|連接|授權).{0,16}王品\s*(?:瀏覽器|browser)|王品\s*(?:瀏覽器|browser).{0,20}(?:開|操作|搜尋|讀|生成|登入|點|上傳|下載)/i.test(line))return 'wangpin';
    return null;
  }
  return null;
}
function requestedWangpin(text, history, alreadySelected) {
  const direct=explicitWangpin(text); if(direct)return direct;
  const current=String(text||'');
  if(alreadySelected || /王品\s*(?:瀏覽器|browser)|brave|chrome|edge|firefox|內建瀏覽器/i.test(current))return null;
  if(!/(?:繼續|再試|重試|接著|再來|授權|可以了|好了)/.test(current))return null;
  for(const m of [...(history||[])].reverse()){
    if(m?.role!=='user')continue;
    const value=String(m.text||'');
    if(/王品\s*(?:瀏覽器|browser)|brave|chrome|edge|firefox|內建瀏覽器/i.test(value))return explicitWangpin(value);
  }
  return null;
}
function identity(value) {
  if (typeof value !== 'string') throw Error('請指定 browser_list 回傳的瀏覽器 ID。');
  const id = value.trim().toLowerCase();
  if (!IDS.includes(id)) throw Error('不支援的瀏覽器 ID；請先呼叫 browser_list，不能傳入路徑或啟動參數。');
  return id;
}
function candidates(id, env = process.env) {
  const bases = [...new Set([env.PROGRAMFILES,env['PROGRAMFILES(X86)'],env.LOCALAPPDATA].filter(Boolean))];
  const tails = {brave:['BraveSoftware/Brave-Browser/Application/brave.exe'],chrome:['Google/Chrome/Application/chrome.exe'],edge:['Microsoft/Edge/Application/msedge.exe'],firefox:['Mozilla Firefox/firefox.exe']}[id] || [];
  return bases.flatMap(base=>tails.map(tail=>path.join(base,...tail.split('/'))));
}
function discover({env = process.env, exists = file=>{try{return fs.statSync(file).isFile();}catch{return false;}}, wangpinPath = ''} = {}) {
  return IDS.map(id=>{
    const files=id==='wangpin'?[require('./wangpinBrowserPaths').resolveExecutable(wangpinPath)]:candidates(id,env);
    const executable=files.find(file=>file&&exists(file)) || '';
    return {id,label:LABELS[id],installed:id==='app'||!!executable,executable,loginMode:id==='wangpin'?'existing_verified_profile':id==='app'?'app_profile':'separate_app_profile',compatibility:id==='app'?'available':'checked_when_connected'};
  });
}
function create({directory, inventory = discover, createController, enabled = ()=>true, idleMs = 30000, maxEntries = 12, maxChoices = 512} = {}) {
  let choices={};const controllers=new Map();let disposed=false;let allocation=Promise.resolve();
  const file=path.join(directory,'browser-choices.json');
  try {const stat=fs.statSync(file);if(stat.size<=256*1024){const data=JSON.parse(fs.readFileSync(file,'utf8'));if(data.version===1&&data.choices&&typeof data.choices==='object')for(const [key,id] of Object.entries(data.choices).slice(-maxChoices)){if(validKey(key)&&IDS.includes(id))choices[key]=id;}}}catch{}
  function validKey(key){return typeof key==='string'&&key.length>0&&key.length<=200&&!/[\u0000-\u001f]/.test(key)&&!['__proto__','constructor','prototype'].includes(key);}
  function check(guard){if(disposed||!enabled())throw Error('瀏覽器操作已關閉。');if(guard&&!guard())throw Error('已停止');}
  function save(){fs.mkdirSync(directory,{recursive:true});const temp=file+'.'+crypto.randomBytes(5).toString('hex')+'.tmp';try{fs.writeFileSync(temp,JSON.stringify({version:1,choices}),'utf8');fs.renameSync(temp,file);}finally{try{fs.unlinkSync(temp);}catch{}}}
  const items=()=>inventory().map(item=>({...item}));
  const publicInfo=item=>({id:item.id,label:item.label,installed:item.installed,loginMode:item.loginMode,compatibility:item.compatibility,note:item.id==='wangpin'?'使用經驗證的原本登入與分頁；未接通時明確報錯。':item.id==='app'?'工作台內建設定檔。':'工作台獨立設定檔，不含你平常瀏覽器的登入與既有分頁；可在此設定檔自行登入。'});
  function selected(key){return choices[key] || null;}
  function bind(key,id,guard){check(guard);identity(id);const item=items().find(item=>item.id===id&&item.installed);if(!item)throw Error(`${LABELS[id]} 未安裝或執行檔不存在；不會改用其他瀏覽器。`);const old=choices;choices={...choices,[key]:id};const keys=Object.keys(choices);for(const stale of keys.slice(0,Math.max(0,keys.length-maxChoices)))delete choices[stale];try{save();}catch(error){choices=old;throw error;}return publicInfo(item);}
  async function retire(entry){if(entry.retiring)return entry.retiring;clearTimeout(entry.timer);let timer;const stop=Promise.resolve().then(()=>{entry.controller.setGuard?.(null);return entry.controller.stop?.();});entry.retiring=Promise.race([stop,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('瀏覽器回收逾時；保留工作階段，暫停重建。')),5000);})]).then(()=>{if(controllers.get(entry.key)===entry)controllers.delete(entry.key);}).finally(()=>clearTimeout(timer));return entry.retiring;}
  function release(entry){entry.active--;entry.at=Date.now();if(entry.active===0&&!disposed){entry.timer=setTimeout(()=>{if(!entry.active)retire(entry).catch(()=>{});},idleMs);entry.timer.unref?.();}}
  function controllerFor(scope,id,guard){const work=allocation.catch(()=>{}).then(async()=>{check(guard);const item=items().find(item=>item.id===id&&item.installed);if(!item)throw Error(`${LABELS[id]} 未安裝或執行檔不存在；不會改用其他瀏覽器。`);const key=scope+':'+id;let entry=controllers.get(key);if(entry?.retiring){await entry.retiring;check(guard);entry=controllers.get(key);}if(!entry){if(controllers.size>=maxEntries){const idle=[...controllers.values()].filter(e=>!e.active).sort((a,b)=>a.at-b.at)[0];if(!idle)throw Error('瀏覽器工作階段已達上限，請等待目前操作完成。');await retire(idle);check(guard);}const controller=createController(item,scope);entry={key,scope,controller,active:0,at:Date.now(),timer:null};controllers.set(key,entry);}clearTimeout(entry.timer);entry.active++;return entry;});allocation=work.then(()=>{},()=>{});return work;}
  function forChat(key,scope=key){if(!validKey(key)||!validKey(scope))throw Error('無效的瀏覽器對話識別碼。');let guard=null;const facade={conversationChoice:true,setGuard:fn=>{guard=fn;},info:()=>({browser:selected(key),selectionRequired:!selected(key)}),list:async()=>{check(guard);return{selected:selected(key),browsers:items().map(publicInfo)};},select:async({browser}={})=>bind(key,identity(browser),guard),stop:async()=>{check(guard);await Promise.all([...controllers.values()].filter(e=>e.scope===scope&&!e.active).map(retire));return{stopped:true};}};
    for(const method of ['start','open','tabs','read','snapshot','click','type','press','scroll','back','forward','wait','screenshot','closeTab','evalRaw'])facade[method]=async(...args)=>{
      check(guard);const captured=guard;let id=selected(key);
      if(method==='open'&&args[0]?.browser){id=identity(args[0].browser);bind(key,id,captured);}
      if(!id)throw Error('尚未選擇瀏覽器。請先 browser_list，再依使用者指定呼叫 browser_select；不要自行猜測。');
      const entry=await controllerFor(scope,id,captured);entry.controller.setGuard?.(()=>!disposed&&enabled()&&(!captured||captured()));
      try{check(captured);return await entry.controller[method](...args);}finally{release(entry);}
    };return facade;
  }
  async function dispose(){disposed=true;await Promise.allSettled([...controllers.values()].map(retire));}
  function forget(key){if(!validKey(key))return;const old=choices;choices={...choices};delete choices[key];try{save();}catch(error){choices=old;throw error;}}
  return{forChat,dispose,forget,selected,inventory:()=>items().map(publicInfo),size:()=>controllers.size};
}
module.exports={create,discover,candidates,identity,explicitWangpin,requestedWangpin,IDS,LABELS};
