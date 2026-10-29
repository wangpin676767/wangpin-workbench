'use strict';
// Website-account transport only. There is deliberately no API-key or browser
// fallback in this module. fetch belongs to one isolated authenticated jar.
const crypto=require('node:crypto');
const ORIGINS={gpt:'https://chatgpt.com',claude:'https://claude.ai',gemini:'https://gemini.google.com'};
const MAX_FRAME=1024*1024,MAX_BODY=16*1024*1024;
const UUID=/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
function failure(message,code='WEBSITE_HTTP_ERROR'){return Object.assign(new Error(message),{code});}
function unsupported(site){return failure(`${site} 的網站帳號 HTTP 協定尚未支援；請明確選擇瀏覽器模式。沒有使用 API Key，也沒有自動切換連線。`,'WEBSITE_HTTP_UNSUPPORTED');}
function abort(){return Object.assign(new Error('已停止網站請求；不會自動重送訊息。'),{name:'AbortError',code:'ABORT_ERR'});}
function create({site,fetch,model='',signal,conversation={},timeoutMs=300000}={}){
 if(!ORIGINS[site]||typeof fetch!=='function')throw new TypeError('An isolated website session fetch is required');
 const origin=ORIGINS[site];let state={};
 if(conversation.conversationId&&UUID.test(conversation.conversationId))state.conversationId=conversation.conversationId;
 if(conversation.parentMessageId&&UUID.test(conversation.parentMessageId))state.parentMessageId=conversation.parentMessageId;
 let selected=String(model||''),organization='',busy=false;
 async function run(fn){
  if(signal?.aborted)throw abort();const controller=new AbortController(),cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});
  const timer=setTimeout(cancel,Math.max(1000,Math.min(Number(timeoutMs)||300000,600000)));timer.unref?.();
  async function request(route,{method='GET',headers={},body}={}){
   if(controller.signal.aborted)throw abort();if(!route.startsWith('/')||route.startsWith('//'))throw new Error('Invalid website route');
   let response;try{response=await fetch(origin+route,{method,headers:{accept:'application/json',...headers},...(body!==undefined?{body:JSON.stringify(body)}:{}),credentials:'include',redirect:'error',signal:controller.signal});}catch(e){if(controller.signal.aborted)throw abort();throw failure('網站 HTTP 連線失敗；未自動開啟瀏覽器或重送訊息。');}
   if(controller.signal.aborted){await response.body?.cancel?.().catch(()=>{});throw abort();}
   if(!response.ok){await response.body?.cancel?.().catch(()=>{});if(response.status===401)throw failure('網站登入已失效，請重新同步王品瀏覽器登入。','WEBSITE_LOGIN_REQUIRED');if(response.status===403)throw failure('網站拒絕 HTTP 存取或要求人機驗證；同步 Cookie 不一定能解除。未自動開啟瀏覽器或重送。','WEBSITE_CHALLENGE_REQUIRED');throw failure(`網站 HTTP 請求失敗（${response.status}）；不會自動重送訊息。`);}
   return response;
  }
  async function read(response,limit=MAX_FRAME){let text='',size=0;const decoder=new TextDecoder('utf-8',{fatal:true}),reader=response.body?.getReader();if(!reader)throw failure('網站沒有提供可讀取的回應。');try{while(true){if(controller.signal.aborted)throw abort();const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw failure('網站回應超過安全讀取上限。');text+=decoder.decode(value,{stream:true});}text+=decoder.decode();return text;}finally{await reader.cancel().catch(()=>{});}}
  async function json(route,opts){const response=await request(route,opts);if(!/json/i.test(response.headers.get('content-type')||'')){await response.body?.cancel?.().catch(()=>{});throw failure('網站要求登入或人機驗證；請先按登入。','WEBSITE_LOGIN_REQUIRED');}try{return JSON.parse(await read(response));}catch(e){if(e.code||e.name==='AbortError')throw e;throw failure('網站回應格式已變更；未重送訊息。','WEBSITE_PROTOCOL_CHANGED');}}
  async function stream(response,onEvent){
   if(!/text\/event-stream/i.test(response.headers.get('content-type')||'')){await response.body?.cancel?.().catch(()=>{});throw failure('網站未回傳支援的文字串流；請完成網站驗證或選擇瀏覽器模式。','WEBSITE_PROTOCOL_CHANGED');}
   const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let pending='',fields=[],eventType='',size=0,ended=false;
   const dispatch=()=>{if(!fields.length){eventType='';return false;}const data=fields.join('\n');fields=[];const stop=onEvent(data,eventType);eventType='';return stop;};
   const line=value=>{if(value==='')return dispatch();if(value.startsWith('event:'))eventType=value.slice(6).trim();else if(value.startsWith('data:'))fields.push(value.slice(5).replace(/^ /,''));if(fields.reduce((n,v)=>n+v.length,0)>MAX_FRAME)throw failure('網站串流事件過大。');return false;};
   try{while(!ended){if(controller.signal.aborted)throw abort();const {done,value}=await reader.read();if(done){pending+=decoder.decode();if(pending)ended=line(pending.replace(/\r$/,''));if(!ended)ended=dispatch();break;}size+=value.byteLength;if(size>MAX_BODY)throw failure('網站回應超過安全讀取上限。');pending+=decoder.decode(value,{stream:true});let at;while((at=pending.indexOf('\n'))>=0){const part=pending.slice(0,at).replace(/\r$/,'');pending=pending.slice(at+1);if(line(part)){ended=true;break;}}if(pending.length>MAX_FRAME)throw failure('網站串流行過大。');}if(controller.signal.aborted)throw abort();if(!ended)throw failure('網站回應提前中斷；已保留部分文字，不會自動重送。','WEBSITE_STREAM_INCOMPLETE');}finally{await reader.cancel().catch(()=>{});}
  }
  try{return await fn({request,json,read,stream,signal:controller.signal});}finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
 }
 async function authenticate(io){
  if(site==='gpt'){const session=await io.json('/api/auth/session');if(typeof session.accessToken!=='string'||!session.accessToken)throw failure('尚未登入 ChatGPT 網站帳號；請按登入。','WEBSITE_LOGIN_REQUIRED');return {authorization:'Bearer '+session.accessToken};}
  if(site==='claude'){const organizations=await io.json('/api/organizations');if(!Array.isArray(organizations)||!organizations.length||!UUID.test(organizations[0]?.uuid||''))throw failure('尚未登入 Claude 網站帳號，或沒有可用組織。','WEBSITE_LOGIN_REQUIRED');organization=organizations[0].uuid;return organizations[0];}
  const response=await io.request('/app'),html=await io.read(response,8*1024*1024);if(!/"SNlM0e"\s*:\s*"[^"\\]+"/.test(html))throw failure('尚未確認 Gemini 網站登入；請按登入。','WEBSITE_LOGIN_REQUIRED');return {};
 }
 async function status(){return run(async io=>{await authenticate(io);return {ok:true,loggedIn:true,site,transport:'site-http'};});}
 async function models(io,auth){
  let rows;
  if(site==='gpt'){const data=await io.json('/backend-api/models',{headers:auth});rows=data.models;}
  else if(site==='claude'){rows=auth.models||auth.available_models;if(!Array.isArray(rows))throw failure('Claude 網站 HTTP 尚無已驗證的模型清單；請填入完整網站模型 ID，或使用瀏覽器模式讀取。','WEBSITE_MODEL_DISCOVERY_UNSUPPORTED');}
  else throw unsupported(site);
  if(!Array.isArray(rows))throw failure('網站模型清單格式已變更。','WEBSITE_PROTOCOL_CHANGED');
  return rows.slice(0,256).map(row=>typeof row==='string'?{id:row,label:row}:{id:row.slug||row.id,label:row.title||row.display_name||row.slug||row.id}).filter(row=>typeof row.id==='string'&&row.id.length<=200&&typeof row.label==='string');
 }
 async function listModels(){return run(async io=>models(io,await authenticate(io)));}
 async function ask(text,{onDelta=()=>{},onStatus=()=>{}}={}){
  if(busy)throw failure('這個網站對話已有請求正在進行。');if(site==='gemini')throw unsupported(site);if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>2*1024*1024)throw failure('網站訊息過大。');
  if(site==='claude'&&!/^claude-[a-z0-9][a-z0-9._-]{0,190}$/.test(selected))throw failure('請提供完整 Claude 網站模型 ID；不會把顯示名稱猜成 API 模型。','WEBSITE_MODEL_REQUIRED');
  busy=true;let answer='';
  try{return await run(async io=>{
   onStatus('正在透過網站帳號 HTTP 連線…');const auth=await authenticate(io);let next={...state},response;
   if(site==='gpt'){
    if(selected){const available=await models(io,auth);if(!available.some(row=>row.id===selected))throw failure('所選模型不在此網站帳號的模型清單；未送出訊息。','WEBSITE_MODEL_UNAVAILABLE');}
    const requirements=await io.json('/backend-api/sentinel/chat-requirements',{method:'POST',headers:{...auth,'content-type':'application/json'},body:{}});
    if(requirements.arkose?.required||requirements.turnstile?.required||requirements.proofofwork?.required||requirements.so?.required)throw failure('ChatGPT 要求網站驗證；請使用明確的瀏覽器模式完成驗證。訊息尚未送出。','WEBSITE_CHALLENGE_REQUIRED');
    if(typeof requirements.token!=='string'||!requirements.token)throw failure('ChatGPT 網站驗證協定已變更；訊息尚未送出。','WEBSITE_PROTOCOL_CHANGED');
    const body={action:'next',messages:[{id:crypto.randomUUID(),author:{role:'user'},content:{content_type:'text',parts:[text]}}],parent_message_id:state.parentMessageId||crypto.randomUUID(),model:selected||'auto',timezone_offset_min:new Date().getTimezoneOffset(),history_and_training_disabled:false,conversation_mode:{kind:'primary_assistant'},force_paragen:false,force_rate_limit:false};if(state.conversationId)body.conversation_id=state.conversationId;
    response=await io.request('/backend-api/conversation',{method:'POST',headers:{...auth,accept:'text/event-stream','content-type':'application/json','openai-sentinel-chat-requirements-token':requirements.token},body});
   }else{
    next.conversationId=state.conversationId||crypto.randomUUID();
    const body={prompt:text,model:selected,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',locale:'zh-TW',rendering_mode:'messages'};
    if(state.conversationId){if(!state.parentMessageId)throw failure('Claude 對話缺少已確認的父訊息；未自動重送。','WEBSITE_PROTOCOL_CHANGED');body.parent_message_uuid=state.parentMessageId;}else body.create_conversation_params={name:'',model:selected,is_temporary:false};
    response=await io.request(`/api/organizations/${organization}/chat_conversations/${next.conversationId}/completion`,{method:'POST',headers:{accept:'text/event-stream','content-type':'application/json','anthropic-client-platform':'web_claude_ai'},body});
   }
   await io.stream(response,(raw,event)=>{
    if(raw==='[DONE]'){if(site!=='gpt')throw failure('網站串流結束格式已變更。','WEBSITE_PROTOCOL_CHANGED');return true;}
    let item;try{item=JSON.parse(raw);}catch{throw failure('網站串流資料格式已變更；不會重送訊息。','WEBSITE_PROTOCOL_CHANGED');}
    if(item.error||item.type==='error'||event==='error')throw failure('網站回覆發生錯誤；已保留收到的文字，不會自動重送。');
    if(site==='gpt'){
     if(item.conversation_id){if(!UUID.test(item.conversation_id)||(state.conversationId&&item.conversation_id!==state.conversationId))throw failure('網站回應對話識別不符，已停止讀取。','WEBSITE_CONVERSATION_MISMATCH');next.conversationId=item.conversation_id;}
     const message=item.message;if(message?.author?.role!=='assistant'||(message.channel&&message.channel!=='final'))return false;
     if(message.id&&UUID.test(message.id))next.parentMessageId=message.id;
     if(message.content?.content_type==='text'){const value=(message.content.parts||[]).filter(part=>typeof part==='string').join('\n');if(!value.startsWith(answer))throw failure('網站回應需要覆寫既有文字，尚未支援此串流格式。','WEBSITE_PROTOCOL_CHANGED');const delta=value.slice(answer.length);answer=value;if(delta)onDelta(delta);}
    }else{
     const kind=item.type||event;
     if(kind==='message_start'){const id=item.message?.id||item.message?.uuid;if(id&&UUID.test(id))next.parentMessageId=id;}
     if(kind==='content_block_delta'&&item.delta?.type==='text_delta'&&typeof item.delta.text==='string'){answer+=item.delta.text;onDelta(item.delta.text);}
     if(kind==='message_stop')return true;
    }
    return false;
   });
   if(!answer.trim())throw failure('網站沒有回傳可讀取的答案。','WEBSITE_STREAM_EMPTY');if(!next.conversationId||!next.parentMessageId)throw failure('網站未提供完整對話識別；已保留文字，未建立可重送狀態。','WEBSITE_PROTOCOL_CHANGED');state=next;
   return {text:answer,model:selected||'auto',conversation:{...state},transport:'site-http'};
  });}catch(error){error.partial=answer;throw error;}finally{busy=false;}
 }
 return {ask,listModels,status,conversation:()=>({...state}),site,transport:'site-http'};
}
module.exports={create,ORIGINS};
