"use strict";
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{execFile}=require('child_process');
const descriptorName='codex-multi-bidi.json';
function defaultProfile(executable){return require('./wangpinBrowserPaths').defaultProfile(executable);}
function installBridge(executable){
 const dir=path.join(path.dirname(executable),'wangpin');
 if(!fs.existsSync(path.join(path.dirname(executable),'wangpin.cfg'))||!fs.existsSync(path.join(dir,'chrome.manifest')))throw Error('此 Firefox 缺少王品瀏覽器控制載入器，請選擇王品瀏覽器的執行檔。');
 const script=path.join(dir,'zz-codex-multi-bridge.uc.js');
 let nonce;try{nonce=/const nonce = "([a-f0-9]{64})"/.exec(fs.readFileSync(script,'utf8'))?.[1];}catch{}
 nonce=nonce||crypto.randomBytes(32).toString('hex');
 const source=`// Codex Multi: attach to this browser profile; never export cookies.
(()=>{if(window.__codexMultiBridge)return;window.__codexMultiBridge=true;
 const nonce = "${nonce}";
 const services=globalThis.Services||ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
 const profile=services.dirsvc.get('ProfD',Components.interfaces.nsIFile);
 const file=profile.clone();file.append('${descriptorName}');
 const IOUtils=globalThis.IOUtils;
 const write=async value=>IOUtils.writeUTF8(file.path,JSON.stringify({version:1,nonce,profileDir:profile.path,executable:services.dirsvc.get('XREExeF',Components.interfaces.nsIFile).path,pid:services.appinfo.processID,...value}),{tmpPath:file.path+'.tmp'});
 let started=false;
 const begin=async()=>{if(started)return;started=true;try{
  await gBrowserInit.idleTasksFinished;
  const {RemoteAgent}=ChromeUtils.importESModule('chrome://remote/content/components/RemoteAgent.sys.mjs');
  if(!RemoteAgent.running){
   // Avoid RemoteAgent's fatal bind-error path if another local application uses 9222.
   const socket=Components.classes['@mozilla.org/network/server-socket;1'].createInstance(Components.interfaces.nsIServerSocket);
   socket.init(9222,true,-1);socket.close();
   services.prefs.setBoolPref('remote.experimental.dynamicstart.enabled',true);
   await RemoteAgent.startAtRuntime({isBrowserAutomation:false});
  }
  if(!RemoteAgent.running||RemoteAgent.port!==9222)throw Error('王品瀏覽器控制埠不是 9222');
  await write({endpoint:'ws://localhost:9222/session',ready:true});
 }catch(error){await write({ready:false,error:String(error)}).catch(()=>{});}};
 if(services.startup.startingUp)setTimeout(begin,1500);else setTimeout(begin,0);
})();\n`;
 if(!fs.existsSync(script)||fs.readFileSync(script,'utf8')!==source)fs.writeFileSync(script,source,'utf8');
 return {nonce,script};
}
function descriptor(profileDir,executable,nonce){
 let data;try{data=JSON.parse(fs.readFileSync(path.join(profileDir,descriptorName),'utf8'));}catch{return null;}
 if(data.nonce!==nonce||path.resolve(data.profileDir||'').toLowerCase()!==path.resolve(profileDir).toLowerCase()||path.dirname(path.resolve(data.executable||'')).toLowerCase()!==path.dirname(path.resolve(executable)).toLowerCase()||!Number.isInteger(data.pid))return null;
 try{process.kill(data.pid,0);}catch{return null;}
 if(!data.ready)throw Error('王品瀏覽器控制無法啟動：'+(data.error||'請重新開啟瀏覽器。'));
 if(data.endpoint!=='ws://localhost:9222/session')throw Error('王品瀏覽器控制位址無效。');
 return data;
}
function running(executable){
 if(process.platform!=='win32')return Promise.resolve(false);
 return new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',"[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); Get-CimInstance Win32_Process -Filter \"name='firefox.exe' OR name='WangpinBrowser.exe'\" | Select-Object -ExpandProperty ExecutablePath"],{windowsHide:true,timeout:10000},(error,stdout)=>{
 if(error)return reject(Error('無法確認王品瀏覽器是否已開啟，已停止另開視窗。'));
 const folder=path.dirname(path.resolve(executable)).toLowerCase();resolve(String(stdout).split(/\r?\n/).some(p=>p.trim()&&path.dirname(path.resolve(p.trim())).toLowerCase()===folder));
 }));
}
async function verifyOwner(data,executable,profileDir){
 if(process.platform!=='win32')throw Error('此平台無法驗證王品瀏覽器控制程序。');
 const command=`[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $p=Get-CimInstance Win32_Process -Filter "ProcessId=${Number(data.pid)}"; $n=Get-NetTCPConnection -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue; [pscustomobject]@{exe=$p.ExecutablePath; command=$p.CommandLine; listeners=@($n | Select-Object LocalAddress,OwningProcess)} | ConvertTo-Json -Compress -Depth 4`;
 const result=await new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:15000,encoding:'utf8'},(error,stdout)=>{if(error)return reject(Error('無法驗證王品瀏覽器控制埠，已停止連線。'));try{resolve(JSON.parse(stdout));}catch{reject(Error('王品瀏覽器控制程序驗證失敗。'));}}));
 if(path.dirname(path.resolve(result.exe||'')).toLowerCase()!==path.dirname(path.resolve(executable)).toLowerCase())throw Error('王品瀏覽器控制程序不符，已停止連線。');
 const profile=/-profile\s+(?:"([^"]+)"|(\S+))/i.exec(result.command||'');
 if(profile){if(path.resolve(profile[1]||profile[2]).toLowerCase()!==path.resolve(profileDir).toLowerCase())throw Error('王品瀏覽器的設定檔不符，已停止連線。');}
 else if(!require('./wangpinBrowserPaths').isInstalled(executable)||/(?:^|\s)-(?:P|profile|ProfileManager)(?:\s|$)/i.test(result.command||'')||!data.profileDir||path.resolve(data.profileDir).toLowerCase()!==path.resolve(profileDir).toLowerCase()||path.resolve(defaultProfile(executable)).toLowerCase()!==path.resolve(profileDir).toLowerCase())throw Error('王品瀏覽器的設定檔不符，已停止連線。');
 if(!result.listeners?.length||result.listeners.some(n=>Number(n.OwningProcess)!==data.pid||!['127.0.0.1','::1'].includes(n.LocalAddress)))throw Error('王品瀏覽器控制埠屬於其他程序，已停止連線。');
 return true;
}
function sessionCapabilities(data,profileDir){
 const file=path.join(profileDir,'wangpin-bidi-hub.json');if(!fs.existsSync(file))return {};
 if(fs.statSync(file).size>256*1024)throw Error('王品瀏覽器控制中樞資訊過大，已停止連線。');
 let hub;try{hub=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw Error('王品瀏覽器控制中樞資訊無效。');}
 if(!hub.hub)return {};
 if(hub.pid!==data.pid||hub.endpoint!==data.endpoint||!hub.running||typeof hub.token!=='string'||!/^[a-f0-9]{64}$/i.test(hub.token))throw Error('王品瀏覽器控制中樞已變更，請重新連線。');
 return {alwaysMatch:{'wangpin:token':hub.token}};
}
module.exports={defaultProfile,installBridge,descriptor,running,descriptorName,verifyOwner,sessionCapabilities};
