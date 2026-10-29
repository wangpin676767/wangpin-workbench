'use strict';
const DOMAINS={gpt:['chatgpt.com','openai.com'],claude:['claude.ai','anthropic.com'],gemini:['google.com']};
async function readCookies({site,signal,browser}={}){
 const domains=DOMAINS[site];if(!domains)throw Error('Invalid website');
 const check=()=>{if(signal?.aborted)throw Object.assign(Error('已取消登入。'),{name:'AbortError'});};
 check();
 const owned=!browser;
 browser=browser||new (require('./firefoxControl').FirefoxBrowser)({reuseProfile:true});
 try{return await browser.serialize(async()=>{
  check();await browser.start();check();
  const cookies=[];
  // Exact domain filters prevent collecting unrelated websites. Only the default
  // profile store is used; container accounts are never silently merged.
  for(const domain of domains)for(const host of [domain,'.'+domain]){
   check();const result=await browser.send('storage.getCookies',{filter:{domain:host},partition:{type:'storageKey',userContext:'default'}});check();
   for(const c of result.cookies||[]){
    if(![domain,'.'+domain].includes(c.domain))continue;
    if(c.value?.type!=='string')throw Error('王品瀏覽器登入資料格式不支援。');
    cookies.push({...c,value:c.value.value,expires:c.expiry,session:c.expiry==null,sameSite:({none:'None',lax:'Lax',strict:'Strict'})[c.sameSite]});
   }
  }
  return {cookies,via:'wangpin'};
 });}finally{if(owned)await browser.stop();}
}
module.exports={readCookies};
