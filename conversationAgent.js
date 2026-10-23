const fs = require('fs');
const path = require('path');

// 收尾（把結果寫回子對話）失敗或卡住時，這次呼叫還是要結掉。
// 不設上限的話，readChat／writeChat 一旦沒有回來，這個代理的鎖就再也放不掉，
// 使用者看到的就是「還在鎖住」，而且等多久都不會好。
const BOOKKEEPING_MS = 15000;

const DEFAULT_PREAMBLE = '你是工作台的任務代理，完成下列任務並回報結果，不要再建立其他代理。\n\n';

function create({run, cancel, readChat, writeChat, deleteChat, newId, parentKey, cwd, provider, model, options, sessionFile, onNotice, onApproval, onActivity}) {
  let childId = null;
  // 同一時間只跑一個子代理，但「還在跑」不該直接讓下一次呼叫失敗：
  // RAGthoven 的下一階段、以及模型自己的重試，真正要的是排隊等它讓出位置。
  let inFlight = null;
  try { childId = JSON.parse(fs.readFileSync(sessionFile,'utf8')).childId || null; } catch {}

  const waitForSlot = async (timeoutMs, signal) => {
    while (inFlight) {
      const current = inFlight;
      if (signal?.aborted) throw new Error('已取消');
      // 等不過前一次自己的時間上限就沒有意義了，所以兩者取小的那個當等待上限
      const wait = Math.max(1000, Math.min(timeoutMs, current.deadline - Date.now() + 5000));
      let timer, onAbort;
      const outcome = await new Promise((resolve) => {
        timer = setTimeout(() => resolve('timeout'), wait);
        onAbort = () => resolve('abort');
        signal?.addEventListener('abort', onAbort, {once:true});
        current.promise.then(() => resolve('free'), () => resolve('free'));
      });
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      if (outcome === 'abort') throw new Error('已取消');
      if (outcome === 'timeout') {
        const secs = Math.round((Date.now() - current.startedAt) / 1000);
        throw new Error(`上一個「${current.label}」已經跑了 ${secs} 秒還沒結束，這次等不到它讓出位置。請先按停止鍵取消這次執行，或等它跑完再交付下一個任務；不要一直重試，重試只會再排一次隊。`);
      }
      if (inFlight === current) inFlight = null;
    }
  };

  return {
    // preamble：送給模型的開頭說明（陪伴角色要傳空字串，不能讓模型以為自己是任務代理）
    // ephemeral：用完就刪掉子對話，也不記成可接續的代理（陪伴角色每回合都呼叫，留著只會塞滿紀錄）
    async ask(message, {followup=false, signal, timeoutMs=1200000, onProgress, name='沿用對話代理', preamble=DEFAULT_PREAMBLE, ephemeral=false}={}) {
      if (ephemeral && followup) throw new Error('一次性呼叫不能接續');
      await waitForSlot(timeoutMs, signal);
      if (signal?.aborted) throw new Error('已取消');
      if (followup && (!childId || !await readChat(childId))) throw new Error('尚未建立代理任務，請先交付任務');
      let release;
      const slot = new Promise((resolve) => { release = resolve; });
      inFlight = {promise: slot, startedAt: Date.now(), deadline: Date.now() + timeoutMs, label: name};
      const mine = inFlight;
      const reqId = newId('extensionrun');
      try {
        if (!followup) {
          childId = newId('agent');
          await writeChat({id:childId,origin:'app',title:`🤖 ${name}`,cwd:cwd||'',messages:[],extensions:[],createdAt:new Date().toISOString(),lastProvider:provider,
            agent:{parentKey,name,provider,model,status:'queued',level:options.permission || options.sandbox || 'chat',task:message}});
          if (sessionFile && !ephemeral) { fs.mkdirSync(path.dirname(sessionFile),{recursive:true}); fs.writeFileSync(sessionFile,JSON.stringify({childId})); }
        }
        if (signal?.aborted) throw new Error('已取消');
        const key = `app:${childId}`;
        const beforeChat=await readChat(childId);
        const beforeCount=beforeChat?.messages?.length || 0;
        if(beforeChat?.agent) {beforeChat.agent.provider=provider;beforeChat.agent.model=model;beforeChat.agent.status='running';await writeChat(beforeChat,{keepTime:true});}
        if(signal?.aborted) throw new Error('已取消');
        onNotice?.(`${name}：沿用 ${provider} / ${model || '目前預設模型'}（${options.via || (provider==='codex'?'Codex 帳號':'API')}），工作台代理引擎`);
        return await new Promise((resolve,reject)=>{
          let text='', ended=false; const tools=[]; const nativeParts=new Map();
          const finish=(error)=>{
            if(ended) return; ended=true; clearTimeout(timer); signal?.removeEventListener('abort',abort);
            const streamed=()=>text || [...nativeParts.values()].join('\n\n');
            const bookkeeping=(async()=>{
              const chat=await readChat(childId);
              const last=[...(chat?.messages||[]).slice(beforeCount)].reverse().find(m=>m.role==='assistant' && m.text);
              const result=streamed() || last?.text;
              if(chat?.agent) {chat.agent.status=error?'failed':'completed';chat.agent.result=result||'';chat.agent.error=error?.message||'';await writeChat(chat,{keepTime:true});}
              return result;
            })().catch(()=>undefined);
            const guard=new Promise((r)=>setTimeout(()=>r(undefined),BOOKKEEPING_MS));
            Promise.race([bookkeeping,guard]).then((result)=>{
              if(error) {reject(error);return;}
              const final=result || streamed();
              if(!final) reject(new Error('代理未回傳文字結果')); else resolve({text:final,tools});
            });
          };
          const abort=()=>{ cancel(reqId); finish(new Error('已取消')); };
          const timer=setTimeout(()=>{cancel(reqId);finish(new Error('代理任務已達時間上限'));},timeoutMs);
          signal?.addEventListener('abort',abort,{once:true});
          const sink={isDestroyed:()=>ended,send:(_channel,event)=>{
            if(event.type==='delta') text+=event.text||'';
            if(event.type==='item' && event.item?.type==='agent_message') nativeParts.set(event.item.id || 'message',event.item.text||'');
            if(event.type==='item' && event.item?.status==='in_progress') {tools.push(event.item.name||event.item.type);onProgress?.(event.item.name||event.item.type,event);}
            if(event.type==='notice') onNotice?.(event.message);
            // 思考、打字、重試狀態：讓呼叫端顯示進度（例如陪伴角色的「正在想…」）
            if(event.type==='reasoning'||event.type==='delta'||event.type==='status') { try { (this?.onActivity || onActivity)?.(event); } catch {} }
            // 子代理自己沒有畫面；要使用者同意的事（例如刪除檔案）改由主對話顯示
            if(event.type==='approval') onApproval?.(event);
            if(event.type==='error'||event.type==='locked') finish(new Error(event.message||'代理失敗'));
            if(event.type==='done') finish(event.cancelled?new Error('已取消'):null);
          }};
          Promise.resolve(run({reqId,key,provider,model,text:`${preamble}${message}`,options:{...options,extensions:[]},agentCtx:{child:true,agentId:childId}},sink)).catch(finish);
        });
      } finally {
        if (ephemeral && childId && deleteChat) { const id = childId; childId = null; await Promise.resolve(deleteChat(id)).catch(() => {}); }
        release();
        if (inFlight === mine) inFlight = null;
      }
    },
  };
}
module.exports={create};
