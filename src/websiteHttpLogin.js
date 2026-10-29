'use strict';
// One account scope for login, discovery and sending. Never fall back to a
// separate browser login when Brave cannot be read: that was a misleading loop.
async function login({site,accountId='default',signal,manager,client,bravePath='',source='wangpin',readCookies}){
  const cancelled=()=>{if(signal?.aborted)throw Object.assign(new Error('已取消登入。'),{name:'AbortError'});};
  cancelled();
  const label=source==='brave'?'Brave':'王品瀏覽器';
  const sync=source==='brave'?manager.syncFromBrave:manager.syncFromWangpin;
  const synced=await sync({site,accountId,bravePath,signal,readCookies});
  cancelled();
  if(!synced.ok)throw Object.assign(new Error(synced.message||`未找到此網站的${label}登入資料，請先在該瀏覽器登入。`),{code:'WEBSITE_COOKIE_MISSING'});
  try{const result=await client.status();cancelled();return {...result,via:source};}
  catch(error){cancelled();throw Object.assign(new Error(label+'登入資料已同步，但 HTTP 驗證失敗：'+error.message),{code:error.code||'WEBSITE_LOGIN_REQUIRED'});}
}
module.exports={login};
