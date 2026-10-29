const http=require('http');
const crypto=require('crypto');
// One authenticated loopback endpoint per run. No global tools or conversation state.
// 工具這邊最長可以跑 60 分鐘（代理任務的 timeout_minutes 上限、Zenith 的 advance_project），
// 呼叫端的逾時要留在它之上，否則會變成「工具還在跑、呼叫端已經放棄」。
const TOOL_TIMEOUT_SEC = 65 * 60;
// 除了總逾時，Claude Code 還有「多久沒有回應或進度就放棄」的閒置逾時（預設 300 秒）。
// 代理任務一跑就是十幾分鐘，中間什麼都不送的話，第 5 分鐘就會被砍掉。
// 所以長的工具呼叫改用 SSE 回應，定期送 notifications/progress 表示還活著。
const HEARTBEAT_MS = 20000;
async function createBridge({tools,execute,cancelled=()=>false,extraInstructions='',heartbeatMs=HEARTBEAT_MS,browserOnly=false}) {
  if(browserOnly && tools.some(t=>!/^(browser|brave)_[a-z_]+$/.test(t?.function?.name||'')))throw Error('Browser bridge only accepts browser tools');
  const token=crypto.randomBytes(32).toString('hex');
  const server=http.createServer(async(req,res)=>{
    const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(body===undefined?'':JSON.stringify(body));};
    if(req.headers.authorization!==`Bearer ${token}` || req.headers.origin || !/^127\.0\.0\.1:\d+$/.test(req.headers.host||'')){send(403,{error:'Forbidden'});return;}
    if(req.url!=='/mcp'){send(404,{});return;}
    if(req.method==='DELETE'){send(200,{});return;}
    if(req.method!=='POST'){send(405,{});return;}
    let rpc;
    try {
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw Error('Request too large');chunks.push(chunk);}
      rpc=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(rpc.id===undefined){send(202);return;}
      let result;
      if(rpc.method==='initialize')result={protocolVersion:rpc.params?.protocolVersion||'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'CodexMulti',version:require('../package.json').version},instructions:(browserOnly?'Only the listed browser tools are available for this conversation. Use browser_list and browser_select to select the browser requested by the user; use browser_snapshot before interacting. No file, command, conversation-history or agent tools are provided by this bridge.':'Tools operate only this conversation. Use browser_snapshot before clicking. Read earlier context with read_conversation when needed. spawn_agent/wait_agents run parallel sub-agents on any model (codex, gpt, claude, deepseek, gemini, grok, meta, ablit) in the same project.')+(extraInstructions?' '+extraInstructions:'')};
      else if(rpc.method==='ping')result={};
      else if(rpc.method==='tools/list')result={tools:tools.map(t=>({name:t.function.name,description:t.function.description,inputSchema:t.function.parameters}))};
      else if(rpc.method==='tools/call'){
        if(cancelled())throw Error('Run stopped');
        if(!tools.some(t=>t.function.name===rpc.params?.name))throw Error('Tool not allowed');
        // 呼叫端（Claude Code／Codex）自己逾時放棄時，只會把 HTTP 連線斷掉。
        // 不往下傳這件事的話，工作台會繼續跑一個已經沒人要的任務，而且一直佔著
        // 沿用對話代理的鎖，之後每一次交付都被擋在「仍在執行」上。
        const abort=new AbortController();
        let done=false;
        const onClose=()=>{ if(!done) abort.abort(); };
        res.on('close',onClose);
        const streaming=/text\/event-stream/.test(req.headers.accept||'');
        const progressToken=rpc.params?._meta?.progressToken;
        let beat=null,step=0,lastMessage='';
        const event=(msg)=>{ if(!res.writableEnded && !res.destroyed) res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`); };
        const progress=(message)=>{
          if(!streaming)return;
          if(progressToken===undefined){ if(!res.writableEnded && !res.destroyed) res.write(': keepalive\n\n'); return; }
          step+=1;event({jsonrpc:'2.0',method:'notifications/progress',params:{progressToken,progress:step,...(message?{message:String(message).slice(0,300)}:{})}});
        };
        if(streaming){
          res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive'});
          beat=setInterval(()=>progress(lastMessage||'仍在執行'),heartbeatMs);
        }
        const onProgress=(message)=>{lastMessage=String(message||'');progress(lastMessage);};
        try{const output=await execute(rpc.params.name,rpc.params.arguments||{},{signal:abort.signal,onProgress});result={content:[{type:'text',text:String(output)}]};}
        catch(e){result={isError:true,content:[{type:'text',text:e.message}]};}
        finally{done=true;if(beat)clearInterval(beat);res.off('close',onClose);}
        if(streaming){event({jsonrpc:'2.0',id:rpc.id,result});res.end();return;}
      }else {send(200,{jsonrpc:'2.0',id:rpc.id,error:{code:-32601,message:'Method not found'}});return;}
      send(200,{jsonrpc:'2.0',id:rpc.id,result});
    }catch(e){
      if(res.headersSent){if(!res.writableEnded){res.write(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',id:rpc?.id??null,error:{code:-32603,message:e.message}})}\n\n`);res.end();}return;}
      send(200,{jsonrpc:'2.0',id:rpc?.id??null,error:{code:-32603,message:e.message}});
    }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const url=`http://127.0.0.1:${server.address().port}/mcp`;
  return {url,token,close(){server.closeAllConnections();server.close();},
    grokServers:[{type:'http',name:'app_browser',url,headers:[{name:'Authorization',value:`Bearer ${token}`}]}],
    claude:{mcpServers:{app_browser:{type:'http',url,headers:{Authorization:`Bearer ${token}`},timeout:TOOL_TIMEOUT_SEC*1000}}},
    codexArgs:['-c',`mcp_servers.app_browser.url=${JSON.stringify(url)}`,'-c',`mcp_servers.app_browser.http_headers={Authorization=${JSON.stringify('Bearer '+token)}}`,'-c','mcp_servers.app_browser.default_tools_approval_mode="approve"','-c','mcp_servers.app_browser.startup_timeout_sec=10','-c',`mcp_servers.app_browser.tool_timeout_sec=${TOOL_TIMEOUT_SEC}`]};
}
module.exports={createBridge,TOOL_TIMEOUT_SEC,HEARTBEAT_MS};
