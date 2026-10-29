'use strict';
const path = require('path');
const { execFile } = require('child_process');
const normalize = value => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
function profileArgument(command) {
  const matches = [...String(command).matchAll(/(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir=([^\s"]+))(?=\s|$)/g)];
  return matches.length === 1 ? matches[0].slice(1).find(Boolean) : '';
}
function verifiedProcess(browser, data, expectedExe) {
  if (!data || !browser.profileDir || !expectedExe || !data.exe || !data.command || !data.pid) return false;
  const listeners = Array.isArray(data.listeners) ? data.listeners : [];
  const profile = profileArgument(data.command);
  return !!profile && normalize(profile) === normalize(browser.profileDir) && normalize(data.exe) === normalize(expectedExe)
    && listeners.length > 0 && listeners.every(item => Number(item.OwningProcess) === Number(data.pid)
      && ['127.0.0.1', '::1'].includes(item.LocalAddress));
}
async function verifyReuse(browser) {
  if (process.platform !== 'win32') return false;
  const port = Number(browser.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  let endpoint;
  try { endpoint = new URL(browser.version.webSocketDebuggerUrl); } catch { return false; }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || Number(endpoint.port) !== port) return false;
  const expectedExe = browser.bravePath || require('./browserControl').findBrave('', { fallback:false }).path;
  if (!expectedExe) return false;
  // Only a validated integer enters PowerShell source; paths are compared in JS.
  const command = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $listeners=@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue); $ids=@($listeners | Select-Object -ExpandProperty OwningProcess -Unique); if($ids.Count -eq 1){$proc=Get-CimInstance Win32_Process -Filter "ProcessId=$($ids[0])"; [pscustomobject]@{pid=$proc.ProcessId;exe=$proc.ExecutablePath;command=$proc.CommandLine;listeners=@($listeners | Select-Object LocalAddress,OwningProcess)} | ConvertTo-Json -Compress -Depth 4}`;
  try {
    const output = await new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],
      {windowsHide:true,timeout:10000,encoding:'utf8',maxBuffer:1024*1024},(error,stdout)=>error ? reject(error) : resolve(stdout)));
    return verifiedProcess(browser,JSON.parse(output),expectedExe);
  } catch { return false; }
}
// Only called before a newly initialized website subsystem has active turns.
// Reused processes require proof of the exact executable, profile and listener.
async function cleanStartup(browser, hosts, options = {}) {
  if (browser.userProfile || !browser.conn) return false;
  if (!browser.owned && !await (options.verifyReuse || verifyReuse)(browser)) return false;
  const allowed = new Set(hosts);
  const wait = options.wait || (ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const now = options.now || Date.now;
  const deadline = now() + (options.budgetMs || 2000);
  const pages = async () => ((await browser.conn.send('Target.getTargets')).targetInfos || []).filter(tab=>tab.type==='page');
  const initial = await pages();
  // Keep an anchor so reclaiming the last website page cannot exit Brave.
  const anchor = initial.find(tab=>tab.url==='about:blank')?.targetId
    || (await browser.conn.send('Target.createTarget',{url:'about:blank',background:true})).targetId;
  const owned = tab => {
    if(tab.targetId===anchor)return false;
    if(tab.url==='about:blank')return true;
    try{return allowed.has(new URL(tab.url).hostname);}catch{return false;}
  };
  let infos = initial, stable = 0;
  while (true) {
    const stale = infos.filter(owned);
    stable = stale.length ? 0 : stable + 1;
    for (const tab of stale) await browser.conn.send('Target.closeTarget',{targetId:tab.targetId});
    if (stable >= 2) return true;
    if (now() >= deadline) throw new Error('Website startup tabs did not settle; refusing to open another conversation.');
    await wait(Math.min(200,Math.max(1,deadline-now())));
    infos = await pages();
  }
}
// Closing an already-removed target can return false. Confirm absence before
// dropping ownership; a timeout or still-existing target remains pending.
async function closeOwnedTarget(conn,targetId) {
  let timer;
  const work=(async()=>{
    try{await conn.send('Target.closeTarget',{targetId});}catch{}
    const deadline=Date.now()+900;
    do {
      try{const data=await conn.send('Target.getTargets');if(!Array.isArray(data?.targetInfos))return false;if(!data.targetInfos.some(t=>t.targetId===targetId))return true;}catch{return false;}
      await new Promise(resolve=>setTimeout(resolve,50));
    }while(Date.now()<deadline);
    return false;
  })();
  try{return await Promise.race([work,new Promise(resolve=>{timer=setTimeout(()=>resolve(false),1000);})]);}finally{clearTimeout(timer);}
}
module.exports={cleanStartup,verifyReuse,verifiedProcess,profileArgument,closeOwnedTarget};
